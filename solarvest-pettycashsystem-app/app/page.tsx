"use client";

import { useState, useMemo } from "react";
import PizZip from "pizzip";
import Docxtemplater from "docxtemplater";
import mammoth from "mammoth";
import { saveAs } from "file-saver";

// We'll use a dynamic import for html2pdf as it's a client-side only lib
const loadHtml2Pdf = () => import("html2pdf.js");
const loadPdfJs = async () => {
    const pdfjs = await import("pdfjs-dist");
    pdfjs.GlobalWorkerOptions.workerSrc = `//unpkg.com/pdfjs-dist@${pdfjs.version}/build/pdf.worker.min.mjs`;
    return pdfjs;
};

const FIELDS = [
  "Description",
  "Transaction Nature",
  "GL Account",
  "Full GL",
  "Petty Cash User",
  "Project ID",
  "Project",
  "Document Date",
  "From",
  "To",
  "Gross Amount",
  "VAT Amount",
  "WHT",
  "Doc Amount",
  "SI/OR Number",
];

export default function Home() {
  const [inputText, setInputText] = useState("");
  const [voucherNumber, setVoucherNumber] = useState("");
  const [position, setPosition] = useState("");
  const [receiptFiles, setReceiptFiles] = useState<File[]>([]);
  const [templateFile, setTemplateFile] = useState<File | null>(null);

  const parsedData = useMemo(() => {
    if (!inputText.trim()) return [];

    const lines = inputText.trim().split("\n");
    return lines.map((line) => {
      // Split by tab (\t) which is standard for spreadsheet copy-paste
      const cells = line.split("\t");
      const row: Record<string, string> = {};
      FIELDS.forEach((field, index) => {
        row[field] = cells[index]?.trim() || "";
      });
      return row;
    });
  }, [inputText]);

  const cash_user = useMemo(() => parsedData.map(row => row["Petty Cash User"])[0] || "", [parsedData]);
  const date = useMemo(() => parsedData.map(row => row["Document Date"])[0] || "", [parsedData]);
  const project_id = useMemo(() => parsedData.map(row => row["Project ID"])[0] || "", [parsedData]);
  const amounts = useMemo(() => parsedData.map(row => row["Doc Amount"]), [parsedData]);
  const totalAmount = useMemo(() => {
    return amounts.reduce((sum, val) => {
      // Remove everything except numbers and decimal point to handle currency strings like "PHP 1,298.00"
      const sanitized = val.replace(/[^0-9.]/g, "");
      const num = parseFloat(sanitized) || 0;
      return sum + num;
    }, 0);
  }, [amounts]);

  const handleGenerateVoucher = async () => {
    if (!templateFile) {
      alert("Please upload a .docx template first!");
      return;
    }

    try {
      // 1. Read the template file
      const arrayBuffer = await templateFile.arrayBuffer();
      const zip = new PizZip(arrayBuffer);
      const doc = new Docxtemplater(zip, {
        paragraphLoop: true,
        linebreaks: true,
      });

      // 2. Prepare data for the template
      const templateData = {
        voucherNumber,
        position,
        cash_user,
        date,
        project_id,
        total_amount: totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }),
        items: parsedData.map((item, index) => ({
          description: item.Description,
          amount: item["Doc Amount"],
        }))
      };

      // 3. Render the template
      doc.render(templateData);

      // 4. Get the filled DOCX content
      const out = doc.getZip().generate({
        type: "blob",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      });

      // 5. Convert filled DOCX to HTML using mammoth
      const arrayBufferOut = await out.arrayBuffer();
      const { value: docHtml } = await mammoth.convertToHtml({ arrayBuffer: arrayBufferOut });

      // Clean up Mammoth plain text elements by injecting style classes
      const polishedHtml = docHtml
        .replace(/<p>\s*PETTY CASH VOUCHER\s*<\/p>/gi, '<div class="voucher-title">PETTY CASH VOUCHER</div>')
        .replace(/<p>\s*Total Amount:/gi, '<p class="total-amount-container">Total Amount:');

      // 6. Create a container for PDF generation with custom layout overrides
      const pdfContainer = document.createElement("div");
      pdfContainer.style.backgroundColor = "white";
      pdfContainer.innerHTML = `
        <style>
          .template-content {
            font-family: Arial, sans-serif;
            color: #111;
            padding: 0px; /* Reset padding here */
          }
          
          /* Centered, Bold, and Scaled Title with Bottom Margin */
          .voucher-title {
            text-align: center;
            font-size: 24px;
            font-weight: bold;
            letter-spacing: 1px;
            margin-top: 10px;
            margin-bottom: 30px;
            text-transform: uppercase;
          }

          .template-content table {
            width: 100%;
            border-collapse: collapse;
            margin-bottom: 20px;
          }

          .template-content th, .template-content td {
            border: 1px solid #000;
            padding: 10px 12px;
            text-align: left;
            vertical-align: middle;
            font-size: 13px;
          }

          /* 1. BOLDS TABLE 1 LABELS: Voucher No., Petty Cash User, Date, Position, Project ID */
          .template-content table:nth-of-type(1) tr td:nth-child(1),
          .template-content table:nth-of-type(1) tr td:nth-child(3) {
            font-weight: bold;
          }

          /* 2. BOLDS TABLE 2 LABELS: Particulars, Amount, Remarks */
          .template-content table:nth-of-type(2) tr:nth-child(1) td {
            font-weight: bold;
            background-color: #f9f9f9; /* Gives the header row a professional light-grey tint */
          }

          /* Total Amount block styling */
          .total-amount-container {
            font-weight: bold;
            font-size: 14px;
            margin-top: 25px;
            margin-bottom: 15px; 
            display: block;
          }

          /* 3. GUARANTEES A GAP BELOW TOTAL PRICE: Pushes Table 3 (Signatures) down */
          .template-content table:nth-of-type(3) {
            margin-top: 45px !important;
            clear: both;
          }

          /* Forces the middle row of the signature table to remain expanded for physical signing */
          .template-content table:nth-of-type(3) tr:nth-child(2) td {
            height: 80px; 
            vertical-align: bottom;
          }

          .template-content table:nth-of-type(3) tr:nth-child(3) td {
            text-align: center; 
            vertical-align: bottom;
          }
        </style>

        <div class="template-content">${polishedHtml}</div>
      `;

      // 7. Add receipts section only if files exist
      if (receiptFiles.length > 0) {
        const receiptsWrap = document.createElement("div");
        receiptsWrap.style.pageBreakBefore = "always";
        receiptsWrap.innerHTML = `
          <div id="receipts-container" style="display: flex; flex-direction: column; gap: 0px; align-items: center; width: 100%;">
          </div>
        `;
        pdfContainer.appendChild(receiptsWrap);

        const receiptsContainer = receiptsWrap.querySelector("#receipts-container");
        for (const file of receiptFiles) {
          if (file.type.startsWith("image/")) {
            const base64 = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onloadend = () => resolve(reader.result);
              reader.readAsDataURL(file);
            });
            const img = document.createElement("img");
            img.src = base64 as string;
            img.style.maxWidth = "100%";
            img.style.maxHeight = "950px";
            img.style.objectFit = "contain";
            img.style.marginBottom = "30px";
            img.style.pageBreakInside = "avoid";
            
            await new Promise((resolve) => {
              img.onload = resolve;
              img.onerror = resolve;
            });
            
            receiptsContainer?.appendChild(img);
          } else if (file.type === "application/pdf") {
            try {
              const pdfjs = await loadPdfJs();
              const arrayBuffer = await file.arrayBuffer();
              const pdf = await pdfjs.getDocument({ data: arrayBuffer }).promise;
              
              for (let i = 1; i <= pdf.numPages; i++) {
                const page = await pdf.getPage(i);
                const viewport = page.getViewport({ scale: 1.5 });
                const canvas = document.createElement("canvas");
                const context = canvas.getContext("2d");
                canvas.height = viewport.height;
                canvas.width = viewport.width;
                
                if (context) {
                  // @ts-ignore
                  await page.render({ canvasContext: context, viewport }).promise;
                  const img = document.createElement("img");
                  img.src = canvas.toDataURL("image/jpeg", 0.8);
                  img.style.maxWidth = "100%";
                  img.style.marginBottom = "30px";
                  img.style.pageBreakInside = "avoid";
                  receiptsContainer?.appendChild(img);
                }
              }
            } catch (e) {
              console.error(`Error rendering PDF ${file.name}:`, e);
              const p = document.createElement("p");
              p.innerText = `[Error rendering PDF: ${file.name}]`;
              receiptsContainer?.appendChild(p);
            }
          }
        }
      }

      // 8. Generate PDF using html2pdf
      const html2pdf = (await loadHtml2Pdf()).default;
      const opt = {
        margin: 0.5,
        filename: `V${voucherNumber?.trim() || "Generated"}.pdf`,
        image: { type: 'jpeg' as const, quality: 0.98 },
        html2canvas: { scale: 2, useCORS: true, logging: false, scrollY: 0 },
        jsPDF: { unit: 'in' as const, format: 'letter' as const, orientation: 'portrait' as const }
      };

      // Set pagebreak options to avoid blank page at the end
      await html2pdf().set(opt).from(pdfContainer).set({
        pagebreak: { mode: ['css', 'legacy'] }
      } as any).save();

    } catch (error) {
      console.error("Error generating voucher:", error);
      alert("Error generating voucher. Ensure your .docx template uses {placeholder} syntax.");
    }
  };

  return (
    <div className="p-8">
      <div className="text-center text-3xl font-bold mb-8">
        <h1>SOLARVEST PETTY CASH SYSTEM</h1>
      </div>

      <div className="max-w-4xl mx-auto mb-8 grid grid-cols-1 md:grid-cols-3 gap-6 items-start bg-gray-50 p-6 rounded-xl border border-gray-200">
        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Voucher Number
          </label>
          <input
            type="text"
            className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 text-black mb-4"
            placeholder="1"
            value={voucherNumber}
            onChange={(e) => setVoucherNumber(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Position
          </label>
          <input
            type="text"
            className="w-full p-2 border border-gray-300 rounded-md shadow-sm focus:ring-2 focus:ring-blue-500 text-black"
            placeholder="Senior Manager"
            value={position}
            onChange={(e) => setPosition(e.target.value)}
          />
        </div>

        <div className="p-3 bg-blue-50 rounded-lg border border-blue-100">
            <span className="text-xs font-semibold text-blue-600 uppercase">Total Amount</span>
            <div className="text-2xl font-bold text-blue-900">
              PHP {totalAmount.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Receipt Upload (Images/PDFs)
          </label>
          <div className="relative">
            <input
              type="file"
              accept="image/*,.pdf"
              multiple
              className="hidden"
              id="receipt-upload"
              onChange={(e) => {
                const files = Array.from(e.target.files || []);
                setReceiptFiles((prev) => [...prev, ...files]);
              }}
            />
            <label
              htmlFor="receipt-upload"
              className="cursor-pointer flex flex-col items-center justify-center px-4 py-2 border-2 border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 border-dashed min-h-[42px]"
            >
              <span>Add Images/PDFs</span>
            </label>
          </div>
          {receiptFiles.length > 0 && (
            <div className="mt-2 space-y-1">
              {receiptFiles.map((file, idx) => (
                <div key={idx} className="flex items-center justify-between bg-white px-2 py-1 rounded border border-gray-100 text-[10px] text-gray-600">
                  <span className="truncate max-w-[150px]">{file.name}</span>
                  <button 
                    onClick={() => setReceiptFiles(prev => prev.filter((_, i) => i !== idx))}
                    className="ml-2 text-red-500 hover:text-red-700"
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700 mb-2">
            Template Upload
          </label>
          <div className="relative">
            <input
              type="file"
              accept=".docx"
              className="hidden"
              id="template-upload"
              onChange={(e) => setTemplateFile(e.target.files?.[0] || null)}
            />
            <label
              htmlFor="template-upload"
              className="cursor-pointer flex items-center justify-center px-4 py-2 border-2 border-gray-300 rounded-md shadow-sm text-sm font-medium text-gray-700 bg-white hover:bg-gray-50 border-dashed"
            >
              {templateFile ? templateFile.name : "Select .docx"}
            </label>
          </div>
        </div>
      </div>

      <div className="mb-8 max-w-4xl mx-auto">
        <div className="flex justify-between items-end mb-2">
          <label className="block text-sm font-medium text-gray-700">
            Paste Spreadsheet Data Here (Tab Separated)
          </label>
          {inputText && (
            <button
              onClick={() => setInputText("")}
              className="text-xs text-red-600 hover:text-red-800 font-semibold"
            >
              Clear Text
            </button>
          )}
        </div>
        <textarea
          className="w-full h-48 p-4 border border-gray-300 rounded-lg shadow-sm focus:ring-2 focus:ring-blue-500 focus:border-blue-500 font-mono text-sm text-black bg-white"
          placeholder="Paste rows from Excel/Google Sheets here..."
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
        />
        <p className="mt-2 text-xs text-gray-500">
          Detected {parsedData.length} row(s). Ensure your data has 15 columns as specified.
        </p>
      </div>

      {parsedData.length > 0 && (
        <div className="overflow-x-auto shadow-md rounded-lg">
          <table className="min-w-full divide-y divide-gray-200 border text-black">
            <thead className="bg-gray-100">
              <tr>
                {FIELDS.map((field) => (
                  <th
                    key={field}
                    className="px-4 py-2 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider border whitespace-nowrap"
                  >
                    {field}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {parsedData.map((row, rowIndex) => (
                <tr key={rowIndex} className="hover:bg-gray-50 transition-colors">
                  {FIELDS.map((field) => (
                    <td
                      key={field}
                      className="px-4 py-2 text-sm text-gray-600 border"
                    >
                      {row[field]}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-12 mb-20 text-center">
        <button
          onClick={handleGenerateVoucher}
          className="bg-blue-600 hover:bg-blue-700 text-white font-bold py-4 px-12 rounded-full shadow-lg transition-all transform hover:scale-105 active:scale-95"
        >
          Generate Voucher
        </button>
      </div>
    </div>
  );
}


