import * as pdfjsLib from 'pdfjs-dist';

// Setting the worker source to the locally installed pdf.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  'pdfjs-dist/build/pdf.worker.mjs',
  import.meta.url
).toString();

export async function extractTextFromPDF(fileData: Uint8Array): Promise<string> {
  const loadingTask = pdfjsLib.getDocument(fileData);
  const pdfDocument = await loadingTask.promise;
  const numPages = pdfDocument.numPages;
  let fullText = "";

  for (let pageNum = 1; pageNum <= numPages; pageNum++) {
    const page = await pdfDocument.getPage(pageNum);
    const textContent = await page.getTextContent();
    const pageText = textContent.items.map((item: any) => item.str).join(' ');
    fullText += `[Page ${pageNum}]\n${pageText}\n\n`;
  }

  return fullText;
}

// In a real implementation, we would return rendered canvas elements or HTML
// For the MVP, we just extract text to feed the LLM. 
