# PDF RAG Website

This is a small website version of your `Lecture_12-13` PDF RAG code.

## How It Works

1. User uploads a PDF.
2. Backend extracts PDF text with `pdf-parse`.
3. Text is split into chunks.
4. Chunks are embedded with Gemini embeddings.
5. Vectors are stored in one Pinecone index.
6. Each browser gets a demo `userId`.
7. Pinecone namespace is `user-{userId}`.
8. Each chunk also stores `documentId` metadata.
9. Questions search only the current user's namespace and current PDF document.

## Setup

```bash
cd pdf-rag-website
npm install
copy .env.example .env
npm run dev
```

Then open:

```txt
http://localhost:3000
```

## Deploy On Vercel

This project can deploy on Vercel as a Node serverless app.

1. Push this folder/repo to GitHub.
2. Import the project on Vercel.
3. Set the root directory to:

```txt
pdf-rag-website
```

4. Add these environment variables in Vercel Project Settings:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
GEMINI_CHAT_MODEL=gemini-2.5-flash
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX_NAME=your_pinecone_index_name
```

5. Deploy.

Vercel serverless functions have execution time limits, so keep free-plan PDFs small. For larger PDFs, use a background job system or deploy the backend on Render, Railway, or a VPS.

## Environment

Put your keys in `.env`:

```env
GEMINI_API_KEY=your_gemini_api_key
GEMINI_EMBEDDING_MODEL=gemini-embedding-001
GEMINI_CHAT_MODEL=gemini-2.5-flash
PINECONE_API_KEY=your_pinecone_api_key
PINECONE_INDEX_NAME=your_pinecone_index_name
PORT=3000
```

## Cost Saving Design

Do not create a new Pinecone index for every user.

This app uses:

- One Pinecone index
- One namespace per user
- One `documentId` per PDF
- Query filter by `documentId`

That keeps the structure cheaper and easier to manage.
