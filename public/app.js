const uploadForm = document.querySelector('#uploadForm');
const askForm = document.querySelector('#askForm');
const pdfInput = document.querySelector('#pdfInput');
const questionInput = document.querySelector('#questionInput');
const messages = document.querySelector('#messages');
const statusText = document.querySelector('#statusText');
const documentText = document.querySelector('#documentText');

let documentId = localStorage.getItem('pdf-rag-document-id') || '';
let documentName = localStorage.getItem('pdf-rag-document-name') || '';
const userId = getOrCreateUserId();

if (documentId && documentName) {
  statusText.textContent = 'Ready';
  documentText.textContent = documentName;
}

uploadForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const file = pdfInput.files[0];
  if (!file) return;

  setBusy(uploadForm, true);
  statusText.textContent = 'Indexing PDF...';
  addMessage('assistant', `Indexing "${file.name}". This can take a little time for large PDFs.`);

  try {
    const formData = new FormData();
    formData.append('pdf', file);
    formData.append('userId', userId);

    const response = await fetch('/api/upload', {
      method: 'POST',
      body: formData
    });
    const data = await readJson(response);

    documentId = data.documentId;
    documentName = data.fileName;
    localStorage.setItem('pdf-rag-document-id', documentId);
    localStorage.setItem('pdf-rag-document-name', documentName);

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
  if (!documentId) {
    addMessage('error', 'Please upload and index a PDF first.');
    return;
  }

  questionInput.value = '';
  addMessage('user', question);
  setBusy(askForm, true);

  try {
    const response = await fetch('/api/ask', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ userId, documentId, question })
    });
    const data = await readJson(response);
    addMessage('assistant', data.answer);
  } catch (error) {
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
  node.textContent = text;
  messages.appendChild(node);
  messages.scrollTop = messages.scrollHeight;
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
