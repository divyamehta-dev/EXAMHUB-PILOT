/**
 * Advanced PDF Importer Engine
 * Handles PDF text extraction, OCR fallback, and heuristic question parsing.
 */

// We will load PDF.js and Tesseract.js dynamically if not already loaded.
async function ensureDependencies() {
  if (!window.pdfjsLib) {
    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.min.js');
    window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/2.16.105/pdf.worker.min.js';
  }
  if (!window.Tesseract) {
    await loadScript('https://cdn.jsdelivr.net/npm/tesseract.js@4.1.1/dist/tesseract.min.js');
  }
}

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.onload = resolve;
    script.onerror = reject;
    document.head.appendChild(script);
  });
}

/**
 * Extracts text from a PDF File object. Uses OCR if the page seems to be a scanned image.
 */
async function extractTextFromPDF(file, onProgress) {
  await ensureDependencies();
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument(arrayBuffer).promise;
  
  let fullText = '';
  let ocrUsed = false;

  for (let i = 1; i <= pdf.numPages; i++) {
    if (onProgress) onProgress(`Extracting page ${i} of ${pdf.numPages}...`);
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageStrings = textContent.items.map(item => item.str);
    let pageText = pageStrings.join(' ');

    // If text is extremely short, it's likely a scanned PDF image.
    if (pageText.length < 50) {
      ocrUsed = true;
      if (onProgress) onProgress(`Running OCR on page ${i} of ${pdf.numPages}...`);
      const viewport = page.getViewport({ scale: 2.0 });
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({ canvasContext: ctx, viewport: viewport }).promise;
      const dataUrl = canvas.toDataURL('image/jpeg');
      
      const { data: { text } } = await Tesseract.recognize(dataUrl, 'eng');
      pageText = text;
    }

    fullText += pageText + '\n\n';
  }
  return { text: fullText, ocrUsed };
}

/**
 * Parses raw text into structured question objects using heuristic regex.
 */
function parseQuestionsFromText(text) {
  const questions = [];
  
  // Clean up text
  let cleanedText = text
    .replace(/Page\s+\d+\s+of\s+\d+/gi, '') // Remove page numbers
    .replace(/\r\n/g, '\n');

  // Split by question indicators. 
  // Looks for "1.", "1)", "Q1", "Q.1", "Question 1", etc. at the start of a line.
  const questionRegex = /^(?:Q(?:uestion(?: No\.?)?)?[\.\-]?\s*\d+|[0-9]+)[\.\)\s:-]/gim;
  
  let match;
  let indices = [];
  while ((match = questionRegex.exec(cleanedText)) !== null) {
    // Ignore lines like "Q.1 - Q.5 Carry ONE mark Each"
    const lineStr = cleanedText.substring(match.index, match.index + 50);
    if (lineStr.match(/carry.*mark/i)) continue;
    indices.push(match.index);
  }

  if (indices.length === 0) return [];

  for (let i = 0; i < indices.length; i++) {
    const start = indices[i];
    const end = (i + 1 < indices.length) ? indices[i + 1] : cleanedText.length;
    let block = cleanedText.substring(start, end).trim();

    // Remove the question prefix to get the raw content
    block = block.replace(/^(?:Q(?:uestion(?: No\.?)?)?[\.\-]?\s*\d+|[0-9]+)[\.\)\s:-]\s*/i, '');
    
    const parsedQ = parseSingleQuestionBlock(block);
    if (parsedQ) questions.push(parsedQ);
  }

  return questions;
}

function parseSingleQuestionBlock(block) {
  const lines = block.split('\n').map(l => l.trim()).filter(l => l);
  let qText = '';
  let options = [];
  let answerMatches = [];
  let metadata = {};
  
  const optionRegex = /^(?:\()?([a-e]|[ivx]+|[1-5])[\.\)](?:\s+(.*))?$/i;
  const answerRegex = /^(?:Ans(?:wer(?: Key)?)?|Correct(?: Answer)?)\s*[:=]\s*(.*)/i;
  const metaRegex = /^(Difficulty|Marks|Negative Marks|Topic|Subject)[\s:]+(.*)/i;

  let state = 'QUESTION'; // QUESTION, OPTIONS, META

  for (const line of lines) {
    // Check answer
    const ansMatch = line.match(answerRegex);
    if (ansMatch) {
      answerMatches.push(ansMatch[1].trim());
      state = 'META';
      continue;
    }

    // Check metadata
    const metaMatch = line.match(metaRegex);
    if (metaMatch) {
      metadata[metaMatch[1].toLowerCase()] = metaMatch[2].trim();
      state = 'META';
      continue;
    }

    // Check options
    const optMatch = line.match(optionRegex);
    if (optMatch) {
      // It's an option line
      state = 'OPTIONS';
      options.push({
        label: optMatch[1].toUpperCase(),
        content: optMatch[2].trim(),
        is_correct: false
      });
      continue;
    }

    // Accumulate question text or append to last option if wrapped
    if (state === 'QUESTION') {
      qText += (qText ? '\n' : '') + line;
    } else if (state === 'OPTIONS' && options.length > 0) {
      // Append to the last option if it wrapped lines
      options[options.length - 1].content += ' ' + line;
    }
  }

  // Parse Answer String
  let type = options.length > 0 ? 'mcq' : 'subjective';
  let isMultipleCorrect = false;

  if (answerMatches.length > 0) {
    let ansRaw = answerMatches[0].toUpperCase();
    
    // Check for comma separated multiple answers (e.g., A, C)
    const answers = ansRaw.split(/[,&]/).map(s => s.trim().replace(/OPTION\s*/i, ''));
    
    if (options.length > 0) {
      let matchedCount = 0;
      options.forEach(o => {
        if (answers.includes(o.label) || answers.includes(o.label.replace(/[\.\)]/g, ''))) {
          o.is_correct = true;
          matchedCount++;
        }
      });
      if (matchedCount > 1) {
        type = 'msq';
      }
    }
  } else {
    // True/False inference if exactly 2 options (True, False)
    if (options.length === 2) {
      const l1 = options[0].content.toLowerCase();
      const l2 = options[1].content.toLowerCase();
      if ((l1 === 'true' && l2 === 'false') || (l1 === 'yes' && l2 === 'no')) {
        type = 'mcq';
      }
    }
  }

  // Set marks
  let marks = parseFloat(metadata['marks']) || 1;

  // Validation warnings
  let warnings = [];
  if (options.length > 0 && !options.some(o => o.is_correct) && answerMatches.length > 0) {
    warnings.push("Answer key found but didn't match any option label.");
  }
  if (options.length === 0 && answerMatches.length === 0) {
    type = 'subjective';
  } else if (options.length > 0 && answerMatches.length === 0) {
    warnings.push("Options found but no correct answer specified.");
  }

  return {
    content: qText,
    type: type,
    marks: marks,
    difficulty: metadata['difficulty']?.toLowerCase() || 'medium',
    options: options.map(o => ({ content: o.content, is_correct: o.is_correct })),
    _warnings: warnings, // Used for UI preview
    _rawAnswer: answerMatches.join(', ')
  };
}
