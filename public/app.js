const uploadForm = document.querySelector('#uploadForm');
const askForm = document.querySelector('#askForm');
const apiKeyForm = document.querySelector('#apiKeyForm');
const apiKeyInput = document.querySelector('#apiKeyInput');
const pdfInput = document.querySelector('#pdfInput');
const questionInput = document.querySelector('#questionInput');
const messages = document.querySelector('#messages');
const statusText = document.querySelector('#statusText');
const documentText = document.querySelector('#documentText');

let documentId = localStorage.getItem('pdf-rag-document-id') || '';
let documentName = localStorage.getItem('pdf-rag-document-name') || '';
const userId = getOrCreateUserId();

// The user's own Gemini API key (BYOK) — kept only in this browser's
// localStorage, never persisted on the server. Sent with each request
// instead of relying on the server's own (rate-limited, shared) key.
let geminiApiKey = localStorage.getItem('pdf-rag-gemini-key') || '';
if (geminiApiKey) {
  apiKeyInput.value = geminiApiKey;
}

let conversationHistory = [];

if (documentId && documentName) {
  statusText.textContent = 'Ready';
  documentText.textContent = documentName;
}

apiKeyForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const key = apiKeyInput.value.trim();
  if (!key) {
    addMessage('error', 'Please paste a valid Gemini API key.');
    return;
  }
  geminiApiKey = key;
  localStorage.setItem('pdf-rag-gemini-key', key);
  addMessage('assistant', 'API key saved in this browser. You can now upload a PDF and ask questions.');
});

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = pdfInput.files[0];
  if (!file) return;

  if (!geminiApiKey) {
    addMessage('error', 'Please enter your Gemini API key first.');
    return;
  }

  setBusy(uploadForm, true);
  statusText.textContent = 'Indexing PDF...';
  addMessage('assistant', `Indexing "${file.name}". This can take a little time for large PDFs.`);

  try {
    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('userId', userId);
    formData.append('geminiApiKey', geminiApiKey);

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await readJson(response);

    documentId = data.documentId;
    documentName = data.fileName;
    localStorage.setItem('pdf-rag-document-id', documentId);
    localStorage.setItem('pdf-rag-document-name', documentName);

    conversationHistory = [];

    statusText.textContent = 'Ready';
    documentText.textContent = `${data.fileName} (${data.chunks} chunks)`;
    addMessage('assistant', `Done. I indexed ${data.pages} pages into ${data.chunks} chunks. Ask me from this PDF now.`);
  } catch (error) {
    statusText.textContent = 'Upload failed';
    addMessage('error', error.message);
  } finally {
    setBusy(uploadForm, false);
  }
});

askForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const question = questionInput.value.trim();
  if (!question) return;
  if (!geminiApiKey) {
    addMessage('error', 'Please enter your Gemini API key first.');
    return;
  }
  if (!documentId) {
    addMessage('error', 'Please upload and index a PDF first.');
    return;
  }

  questionInput.value = '';
  addMessage('user', question);
  setBusy(askForm, true);

  const thinkingNode = addMessage('assistant thinking', 'Rewriting your question ');
  const stageTimeout1 = setTimeout(() => {
    thinkingNode.textContent = 'Searching the document ';
  }, 1500);
  const stageTimeout2 = setTimeout(() => {
    thinkingNode.textContent = 'Generating your answer ';
  }, 3500);

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        userId,
        documentId,
        question,
        history: conversationHistory,
        geminiApiKey
      })
    });
    const data = await readJson(response);

    clearTimeout(stageTimeout1);
    clearTimeout(stageTimeout2);
    thinkingNode.remove();
    addMessage('assistant', data.answer);

    conversationHistory.push({ question, answer: data.answer });
  } catch (error) {
    clearTimeout(stageTimeout1);
    clearTimeout(stageTimeout2);
    thinkingNode.remove();
    addMessage('error', error.message);
  } finally {
    setBusy(askForm, false);
  }
});

function getOrCreateUserId() {
  const existing = localStorage.getItem('pdf-rag-user-id');
  if (existing) return existing;

  const generated = `demo_${crypto.randomUUID().replaceAll('-', '').slice(0, 18)}`;
  localStorage.setItem('pdf-rag-user-id', generated);
  return generated;
}

function addMessage(type, text) {
  const node = document.createElement('div');
  node.className = `message ${type}`;

  if (type.includes('assistant') && !type.includes('thinking')) {
    node.innerHTML = marked.parse(text);
  } else {
    node.textContent = text;
  }

  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
  return node;
}

function setBusy(form, busy) {
  for (const element of form.querySelectorAll('button, input')) {
    element.disabled = busy;
  }
}

async function readJson(response) {
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || 'Request failed.');
  }
  return data;
}