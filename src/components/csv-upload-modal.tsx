"use client";

import { useState, useRef, useCallback } from "react";
import { uploadLeadsCsv, previewLeadsCsv, type CsvPreviewResponse, type CsvUploadResponse } from "@/lib/api/leads";
import { ApiClientError } from "@/lib/api/client";

interface CsvUploadModalProps {
  isOpen: boolean;
  onClose: () => void;
  campaignId: string;
  campaignName: string;
  onSuccess: (result: CsvUploadResponse) => void;
}

export function CsvUploadModal({
  isOpen,
  onClose,
  campaignId,
  campaignName,
  onSuccess,
}: CsvUploadModalProps) {
  const [inputMode, setInputMode] = useState<"file" | "paste">("file");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [pastedText, setPastedText] = useState("");
  const [skipExisting, setSkipExisting] = useState(true);

  // Preview & Processing state
  const [isPreviewLoading, setIsPreviewLoading] = useState(false);
  const [previewData, setPreviewData] = useState<CsvPreviewResponse | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadResult, setUploadResult] = useState<CsvUploadResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  const fileInputRef = useRef<HTMLInputElement>(null);

  // Trigger preview when file or text is provided
  const handleFileSelected = useCallback(async (file: File) => {
    setSelectedFile(file);
    setError(null);
    setPreviewData(null);
    setUploadResult(null);
    setIsPreviewLoading(true);

    try {
      const preview = await previewLeadsCsv(campaignId, file);
      setPreviewData(preview);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to parse CSV file");
    } finally {
      setIsPreviewLoading(false);
    }
  }, [campaignId]);

  const handlePastePreview = useCallback(async (text: string) => {
    setPastedText(text);
    if (!text.trim()) {
      setPreviewData(null);
      return;
    }
    setError(null);
    setUploadResult(null);
    setIsPreviewLoading(true);

    try {
      const preview = await previewLeadsCsv(campaignId, text);
      setPreviewData(preview);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to parse pasted CSV text");
    } finally {
      setIsPreviewLoading(false);
    }
  }, [campaignId]);

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files && files.length > 0) {
      const file = files[0];
      if (file.name.endsWith(".csv") || file.name.endsWith(".txt") || file.type.includes("csv")) {
        void handleFileSelected(file);
      } else {
        setError("Please upload a .csv or .txt file.");
      }
    }
  };

  const handleDownloadSample = () => {
    const sampleCsv = [
      "username,full_name,biography,email,phone,website,category,followers",
      "natashafit,Natasha Romanoff,Certified Fitness Trainer,natasha@example.com,+12125550192,https://natashafit.com,Fitness,45200",
      "tony_design,Tony Stark,Principal Architect & Founder,tony@starkdesigns.io,,https://starkdesigns.io,Design Agency,18500",
      "https://instagram.com/bruce_wellness/,Bruce Banner,Holistic Health Coach,bruce@wellness.org,+14155550183,,Health & Wellness,32400",
    ].join("\n");

    const blob = new Blob([sampleCsv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.setAttribute("download", "instagram_leads_template.csv");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  };

  const handleUpload = async () => {
    if (!selectedFile && !pastedText.trim()) return;

    setIsUploading(true);
    setError(null);

    try {
      const content = selectedFile || pastedText;
      const result = await uploadLeadsCsv(campaignId, content, { skipExisting });
      setUploadResult(result);
      onSuccess(result);
    } catch (err) {
      setError(err instanceof ApiClientError ? err.message : "Failed to import leads from CSV");
    } finally {
      setIsUploading(false);
    }
  };

  const handleReset = () => {
    setSelectedFile(null);
    setPastedText("");
    setPreviewData(null);
    setUploadResult(null);
    setError(null);
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-xs overflow-y-auto">
      <div className="relative w-full max-w-2xl rounded-2xl border border-zinc-800 bg-zinc-900 shadow-2xl overflow-hidden my-8">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-zinc-800 px-6 py-4 bg-zinc-950/40">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/20 text-sm">
                📄
              </span>
              <h3 className="text-base font-bold text-zinc-100">Upload Leads via CSV</h3>
            </div>
            <p className="mt-0.5 text-xs text-zinc-400">
              Import Instagram leads with contact details into <strong className="text-zinc-200">{campaignName}</strong>
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={isUploading}
            className="rounded-lg p-1 text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200 transition disabled:opacity-50"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content Body */}
        <div className="p-6 space-y-5">
          {uploadResult ? (
            /* Success Summary View */
            <div className="space-y-5 py-2">
              <div className="rounded-xl border border-emerald-500/20 bg-emerald-500/10 p-4 text-center space-y-2">
                <div className="inline-flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/20 text-emerald-400 text-lg font-bold">
                  ✓
                </div>
                <h4 className="text-sm font-bold text-emerald-300">CSV Import Completed Successfully!</h4>
                <p className="text-xs text-emerald-200/80 max-w-md mx-auto">
                  Leads have been parsed, validated, and saved to your campaign directory.
                </p>
              </div>

              {/* Stats Grid */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-center">
                  <div className="text-xs text-zinc-400">Total Rows</div>
                  <div className="text-lg font-bold text-zinc-100 mt-0.5">{uploadResult.totalRows}</div>
                </div>
                <div className="rounded-xl border border-emerald-500/20 bg-emerald-950/20 p-3 text-center">
                  <div className="text-xs text-emerald-400">New Leads Added</div>
                  <div className="text-lg font-bold text-emerald-300 mt-0.5">+{uploadResult.createdCount}</div>
                </div>
                <div className="rounded-xl border border-indigo-500/20 bg-indigo-950/20 p-3 text-center">
                  <div className="text-xs text-indigo-400">Existing Updated</div>
                  <div className="text-lg font-bold text-indigo-300 mt-0.5">{uploadResult.updatedCount}</div>
                </div>
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-3 text-center">
                  <div className="text-xs text-zinc-400">Duplicates Skipped</div>
                  <div className="text-lg font-bold text-zinc-300 mt-0.5">{uploadResult.skippedDuplicates}</div>
                </div>
              </div>

              {/* Sample leads list */}
              {uploadResult.sampleLeads && uploadResult.sampleLeads.length > 0 && (
                <div className="rounded-xl border border-zinc-800 bg-zinc-950/40 p-3">
                  <div className="text-xs font-semibold uppercase text-zinc-400 mb-2">Sample Imported Leads</div>
                  <div className="divide-y divide-zinc-800/60">
                    {uploadResult.sampleLeads.map((lead) => (
                      <div key={lead.id} className="py-1.5 flex items-center justify-between text-xs">
                        <span className="font-semibold text-rose-400">@{lead.username}</span>
                        <span className="text-zinc-400">{lead.fullName || "-"}</span>
                        <span className="text-[10px] rounded px-1.5 py-0.5 bg-zinc-800 text-zinc-300">
                          {lead.status}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex justify-end pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded-lg bg-emerald-600 px-5 py-2 text-xs font-semibold text-white hover:bg-emerald-500 transition shadow-sm"
                >
                  Done & View Leads
                </button>
              </div>
            </div>
          ) : (
            /* Upload & Preview View */
            <>
              {/* Tab Selector & Sample Template */}
              <div className="flex items-center justify-between">
                <div className="flex items-center rounded-lg bg-zinc-950 p-1 border border-zinc-800 text-xs">
                  <button
                    type="button"
                    onClick={() => {
                      setInputMode("file");
                      handleReset();
                    }}
                    className={`px-3 py-1 rounded-md font-medium transition ${
                      inputMode === "file"
                        ? "bg-zinc-800 text-zinc-100 shadow-xs"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Upload .CSV File
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setInputMode("paste");
                      handleReset();
                    }}
                    className={`px-3 py-1 rounded-md font-medium transition ${
                      inputMode === "paste"
                        ? "bg-zinc-800 text-zinc-100 shadow-xs"
                        : "text-zinc-400 hover:text-zinc-200"
                    }`}
                  >
                    Paste Text / Handles
                  </button>
                </div>

                <button
                  type="button"
                  onClick={handleDownloadSample}
                  className="text-xs text-rose-400 hover:text-rose-300 font-medium flex items-center gap-1 transition"
                >
                  <svg className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                  </svg>
                  <span>Download Sample Template</span>
                </button>
              </div>

              {/* File Dropzone or Paste Text Area */}
              {inputMode === "file" ? (
                <div
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                  className={`border-2 border-dashed rounded-xl p-6 text-center cursor-pointer transition ${
                    isDragOver
                      ? "border-rose-500 bg-rose-500/10"
                      : selectedFile
                        ? "border-emerald-500/40 bg-emerald-500/5"
                        : "border-zinc-700 hover:border-zinc-500 bg-zinc-950/40 hover:bg-zinc-950/60"
                  }`}
                >
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept=".csv,text/csv,text/plain"
                    className="hidden"
                    onChange={(e) => {
                      if (e.target.files && e.target.files.length > 0) {
                        void handleFileSelected(e.target.files[0]);
                      }
                    }}
                  />
                  <div className="space-y-1.5">
                    <span className="text-2xl block">📁</span>
                    {selectedFile ? (
                      <div>
                        <p className="text-xs font-semibold text-emerald-400">
                          {selectedFile.name} ({(selectedFile.size / 1024).toFixed(1)} KB)
                        </p>
                        <p className="text-[11px] text-zinc-400 mt-0.5">Click or drag another file to replace</p>
                      </div>
                    ) : (
                      <div>
                        <p className="text-xs font-semibold text-zinc-200">
                          Click to select a CSV file, or drag and drop here
                        </p>
                        <p className="text-[11px] text-zinc-500 mt-0.5">Supports .csv and .txt with handles or profile URLs</p>
                      </div>
                    )}
                  </div>
                </div>
              ) : (
                <div className="space-y-1.5">
                  <textarea
                    rows={6}
                    value={pastedText}
                    onChange={(e) => void handlePastePreview(e.target.value)}
                    placeholder={"Paste CSV rows or Instagram handles here, one per line:\n\n@handle1, Alex Rivera, Fitness Coach, alex@example.com\nhttps://instagram.com/handle2/\nhandle3"}
                    className="w-full rounded-xl border border-zinc-700 bg-zinc-950 p-3 text-xs text-zinc-200 placeholder-zinc-500 focus:border-rose-500 focus:outline-none font-mono"
                  />
                  <p className="text-[11px] text-zinc-500">
                    Accepts comma-separated values, full profile URLs, or plain handles (@username).
                  </p>
                </div>
              )}

              {/* Loading Preview */}
              {isPreviewLoading && (
                <div className="text-center py-4 text-xs text-zinc-400 animate-pulse">
                  Parsing and validating CSV data...
                </div>
              )}

              {/* Preview Box */}
              {previewData && (
                <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-950/60 p-4 text-xs">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-800 pb-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-zinc-200">Data Preview:</span>
                      <span className="rounded-full bg-emerald-500/10 border border-emerald-500/20 px-2 py-0.5 text-[11px] text-emerald-400 font-semibold">
                        {previewData.validCount} Valid Leads Found
                      </span>
                      {previewData.invalidCount > 0 && (
                        <span className="rounded-full bg-amber-500/10 border border-amber-500/20 px-2 py-0.5 text-[11px] text-amber-400 font-medium">
                          {previewData.invalidCount} Invalid Skipped
                        </span>
                      )}
                    </div>
                    <span className="text-[11px] text-zinc-400">Total Rows: {previewData.totalRows}</span>
                  </div>

                  {/* Detected Column Mapping */}
                  <div>
                    <span className="text-[11px] uppercase tracking-wider text-zinc-400 font-semibold block mb-1.5">
                      Detected Fields:
                    </span>
                    <div className="flex flex-wrap gap-1.5">
                      {Object.entries(previewData.columnMapping).map(([field, colName]) => (
                        <span
                          key={field}
                          className="rounded-md bg-zinc-800/80 border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300"
                        >
                          <strong className="text-rose-400">{field}:</strong> {colName}
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Preview Rows Table */}
                  {previewData.previewRows.length > 0 && (
                    <div className="overflow-x-auto rounded-lg border border-zinc-800 mt-2">
                      <table className="w-full text-left text-[11px]">
                        <thead className="bg-zinc-900 border-b border-zinc-800 text-zinc-400">
                          <tr>
                            <th className="px-3 py-2 font-semibold">Username</th>
                            <th className="px-3 py-2 font-semibold">Name</th>
                            <th className="px-3 py-2 font-semibold">Email</th>
                            <th className="px-3 py-2 font-semibold">Phone</th>
                            <th className="px-3 py-2 font-semibold">Category</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-zinc-800/60 bg-zinc-950/40">
                          {previewData.previewRows.map((row, idx) => (
                            <tr key={idx} className="hover:bg-zinc-900/30">
                              <td className="px-3 py-1.5 font-medium text-rose-300">{row.username}</td>
                              <td className="px-3 py-1.5 text-zinc-300">{row.fullName || "-"}</td>
                              <td className="px-3 py-1.5 text-zinc-400 font-mono text-[10px]">{row.email || "-"}</td>
                              <td className="px-3 py-1.5 text-zinc-400 font-mono text-[10px]">{row.phone || "-"}</td>
                              <td className="px-3 py-1.5 text-zinc-400">{row.category || "-"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Errors snippet if any */}
                  {previewData.errors.length > 0 && (
                    <div className="mt-2 text-[11px] text-amber-300 bg-amber-500/5 rounded-lg border border-amber-500/20 p-2.5">
                      <span className="font-semibold block mb-0.5">Validation Notices:</span>
                      <ul className="list-disc pl-4 space-y-0.5 text-zinc-400">
                        {previewData.errors.slice(0, 3).map((err, i) => (
                          <li key={i}>
                            Row {err.row}: {err.reason} ({err.snippet})
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}

              {/* Options */}
              <div className="flex items-center gap-2 pt-1 text-xs text-zinc-300">
                <input
                  id="skip-existing-leads"
                  type="checkbox"
                  checked={skipExisting}
                  onChange={(e) => setSkipExisting(e.target.checked)}
                  className="h-4 w-4 rounded border-zinc-700 bg-zinc-950 text-rose-600 focus:ring-rose-500"
                />
                <label htmlFor="skip-existing-leads" className="cursor-pointer select-none">
                  Skip leads that already exist in this campaign (prevent duplicates)
                </label>
              </div>

              {/* Error Message */}
              {error && (
                <div className="rounded-xl border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-300">
                  {error}
                </div>
              )}

              {/* Footer Actions */}
              <div className="flex items-center justify-end gap-3 pt-3 border-t border-zinc-800">
                <button
                  type="button"
                  onClick={onClose}
                  disabled={isUploading}
                  className="rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-2 text-xs font-semibold text-zinc-300 hover:bg-zinc-800 transition disabled:opacity-50"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  id="submit-csv-leads-btn"
                  onClick={handleUpload}
                  disabled={isUploading || isPreviewLoading || !previewData || previewData.validCount === 0}
                  className="rounded-lg bg-gradient-to-r from-rose-600 to-indigo-600 px-5 py-2 text-xs font-semibold text-white shadow-md transition hover:from-rose-500 hover:to-indigo-500 disabled:opacity-40 disabled:cursor-not-allowed flex items-center gap-2"
                >
                  {isUploading ? (
                    <>
                      <span className="h-3.5 w-3.5 border-2 border-white/30 border-t-white rounded-full animate-spin" />
                      <span>Importing Leads...</span>
                    </>
                  ) : (
                    <>
                      <span>Import {previewData?.validCount ? `${previewData.validCount} Leads` : "Leads"}</span>
                      <span>&rarr;</span>
                    </>
                  )}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
