import 'dotenv/config';
import express from 'express';
import multer from 'multer';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nanoid } from 'nanoid';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { GoogleGenAI } from '@google/genai';
import { Pinecone } from '@pinecone-database/pinecone';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const uploadsDir = process.env.VERCEL ? '/tmp/pdf-rag-uploads' : path.join(__dirname, 'uploads');

await mkdir(uploadsDir, { recursive: true });

// Only Pinecone stays server-owned (single shared index, isolated by
// namespace/documentId). Gemini can now come from the user's own key
// (BYOK) so a public deployment doesn't burn one shared free-tier quota.
const requiredEnv = ['PINECONE_API_KEY', 'PINECONE_INDEX_NAME'];
for (const key of requiredEnv) {
  if (!process.env[key]) {
    console.warn(`Missing ${key}. Add it in pdf-rag-website/.env before running the app.`);
  }
}

const app = express();
const upload = multer({
  dest: uploadsDir,
  limits: {
    fileSize: 8 * 1024 * 1024
  },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype !== 'application/pdf') {
      cb(new Error('Only PDF files are allowed.'));
      return;
    }
    cb(null, true);
  }
});

const embeddingModel = process.env.GEMINI_EMBEDDING_MODEL || 'gemini-embedding-001';
const chatModel = process.env.GEMINI_CHAT_MODEL || 'gemini-2.5-flash';

let pineconeIndex;

if (hasRequiredEnv()) {
  const pinecone = new Pinecone({
    apiKey: process.env.PINECONE_API_KEY
  });
  pineconeIndex = pinecone.Index(process.env.PINECONE_INDEX_NAME);
}

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function getNamespace(userId) {
  return `user-${userId}`;
}

function getUserScopedIndex(userId) {
  return pineconeIndex.namespace(getNamespace(userId));
}

function validateUserId(userId) {
  return typeof userId === 'string' && /^[a-zA-Z0-9_-]{6,80}$/.test(userId);
}

function hasRequiredEnv() {
  return requiredEnv.every((key) => Boolean(process.env[key]));
}

// Builds a Gemini client from the caller's own API key (BYOK). Falls back
// to the server's GEMINI_API_KEY (if one is set in .env) so local/dev use
// still works without every developer needing to paste a key.
function getAiClient(userProvidedKey) {
  const apiKey = (userProvidedKey && userProvidedKey.trim()) || process.env.GEMINI_API_KEY;
  if (!apiKey) return null;
  return new GoogleGenAI({ apiKey });
}

function ensureConfigured(res, ai) {
  if (ai && pineconeIndex) return true;

  if (!ai) {
    res.status(400).json({
      error: 'A Gemini API key is required. Please enter your key in the sidebar.'
    });
    return false;
  }

  res.status(500).json({
    error: 'Server is missing PINECONE_API_KEY or PINECONE_INDEX_NAME in .env.'
  });
  return false;
}

app.post('/api/upload', upload.single('pdf'), async (req, res, next) => {
  const { userId, geminiApiKey } = req.body;
  const file = req.file;
  const ai = getAiClient(geminiApiKey);

  if (!ensureConfigured(res, ai)) {
    await cleanupFile(file?.path);
    return;
  }

  if (!validateUserId(userId)) {
    await cleanupFile(file?.path);
    res.status(400).json({ error: 'Invalid user id.' });
    return;
  }

  if (!file) {
    res.status(400).json({ error: 'PDF file is required.' });
    return;
  }

  const documentId = nanoid(12);
  const originalName = file.originalname;

  try {
    const buffer = await readFile(file.path);
    const parsed = await pdf(buffer);
    const chunks = splitText(parsed.text, {
      chunkSize: 1000,
      chunkOverlap: 150
    });

    if (chunks.length === 0) {
      res.status(400).json({ error: 'No readable text was found in this PDF.' });
      return;
    }

    const BATCH_SIZE = 5;
    const records = [];

    for (let i = 0; i < chunks.length; i += BATCH_SIZE) {
      const batch = chunks.slice(i, i + BATCH_SIZE);
      const batchValues = await Promise.all(batch.map((text) => embedText(ai, text)));

      batchValues.forEach((values, batchIndex) => {
        const index = i + batchIndex;
        records.push({
          id: `${documentId}-${index}`,
          values,
          metadata: {
            userId,
            documentId,
            fileName: originalName,
            chunkIndex: index,
            text: batch[batchIndex],
            uploadedAt: new Date().toISOString()
          }
        });
      });

      if (i + BATCH_SIZE < chunks.length) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    const namespaceIndex = getUserScopedIndex(userId);
    for (let i = 0; i < records.length; i += 20) {
      await namespaceIndex.upsert(records.slice(i, i + 20));
    }

    res.json({
      documentId,
      fileName: originalName,
      pages: parsed.numpages,
      chunks: chunks.length,
      namespace: getNamespace(userId)
    });
  } catch (error) {
    next(error);
  } finally {
    await cleanupFile(file.path);
  }
});

app.post('/api/ask', async (req, res, next) => {
  const { userId, documentId, question, history = [], geminiApiKey } = req.body;
  const ai = getAiClient(geminiApiKey);

  if (!ensureConfigured(res, ai)) return;

  if (!validateUserId(userId) || !documentId || !question?.trim()) {
    res.status(400).json({ error: 'userId, documentId, and question are required.' });
    return;
  }

  try {
    const standaloneQuestion = await rewriteQuery(ai, question, history);

    const queryVector = await embedText(ai, standaloneQuestion);
    const searchResults = await getUserScopedIndex(userId).query({
      topK: 6,
      vector: queryVector,
      includeMetadata: true,
      filter: { documentId }
    });

    const matches = searchResults.matches ?? [];
    const context = matches
      .map((match, index) => {
        return `Source ${index + 1}, chunk ${match.metadata?.chunkIndex ?? 'unknown'}:\n${match.metadata?.text ?? ''}`;
      })
      .join('\n\n---\n\n');

    const prompt = `
You are a helpful PDF assistant.

Use only this PDF context to answer:
${context}

User question:
${standaloneQuestion}

Rules:
- If the answer is not available in the context, say: "I don't have enough information in this PDF to answer that."
- Keep normal answers under 100 words.
- If the user asks to explain, describe, or give detail, answer in about 150-220 words.
- Mention chunk numbers when useful.

Answer:
`;

    const response = await ai.models.generateContent({
      model: chatModel,
      contents: prompt,
      config: {
        temperature: 0.2
      }
    });

    res.json({
      answer: response.text,
      rewrittenQuestion: standaloneQuestion,
      sources: matches.map((match) => ({
        score: match.score,
        fileName: match.metadata?.fileName,
        chunkIndex: match.metadata?.chunkIndex
      }))
    });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({
    error: error.message || 'Something went wrong.'
  });
});

async function embedText(ai, text) {
  const response = await ai.models.embedContent({
    model: embeddingModel,
    contents: text
  });
  const values = response.embeddings?.[0]?.values;
  if (!values?.length) {
    throw new Error('Embedding API returned an empty vector.');
  }
  return values;
}

async function rewriteQuery(ai, question, history) {
  if (!Array.isArray(history) || history.length === 0) {
    return question;
  }

  const recentHistory = history
    .slice(-3)
    .map((turn) => `User: ${turn.question}\nAssistant: ${turn.answer}`)
    .join('\n\n');

  const rewritePrompt = `
Given this conversation history and a follow-up question, rewrite the follow-up
question as a standalone question that includes full context. If the follow-up
question is already standalone, return it unchanged. Return ONLY the rewritten
question, with no extra text or explanation.

Conversation history:
${recentHistory}

Follow-up question: ${question}

Standalone question:
`;

  try {
    const response = await ai.models.generateContent({
      model: chatModel,
      contents: rewritePrompt,
      config: {
        temperature: 0
      }
    });

    const rewritten = response.text?.trim();
    return rewritten || question;
  } catch (error) {
    console.error('Query rewrite failed, falling back to original question:', error);
    return question;
  }
}

function splitText(text, { chunkSize, chunkOverlap }) {
  const cleanText = text.replace(/\s+/g, ' ').trim();
  if (!cleanText) return [];

  const chunks = [];
  let start = 0;
  while (start < cleanText.length) {
    let end = Math.min(start + chunkSize, cleanText.length);
    const sentenceEnd = cleanText.lastIndexOf('.', end);
    if (sentenceEnd > start + chunkSize * 0.6) {
      end = sentenceEnd + 1;
    }

    chunks.push(cleanText.slice(start, end).trim());
    if (end === cleanText.length) break;
    start = Math.max(0, end - chunkOverlap);
  }

  return chunks;
}

async function cleanupFile(filePath) {
  if (!filePath) return;
  try {
    await unlink(filePath);
  } catch {
    // Temporary upload may already be gone.
  }
}

if (!process.env.VERCEL) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => {
    console.log(`PDF RAG website running at http://localhost:${port}`);
  });
}

export default app;