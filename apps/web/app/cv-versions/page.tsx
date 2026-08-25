"use client";

import { useState } from "react";

type Status = "idle" | "requesting" | "uploading" | "done" | "error";

export default function CvVersionsPage() {
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!file) return;

    setError(null);
    setStatus("requesting");
    try {
      const createResponse = await fetch("/api/cv-versions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          label,
          fileName: file.name,
          contentType: file.type,
          fileSizeBytes: file.size,
        }),
      });

      if (!createResponse.ok) {
        const body = await createResponse.json().catch(() => ({}));
        throw new Error(body.error || `Request failed with ${createResponse.status}`);
      }

      const { uploadUrl } = await createResponse.json();

      setStatus("uploading");
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": file.type },
        body: file,
      });

      if (!uploadResponse.ok) {
        throw new Error(`Upload failed with ${uploadResponse.status}`);
      }

      setStatus("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStatus("error");
    }
  }

  return (
    <div className="mx-auto flex max-w-md flex-col gap-6 p-16">
      <h1 className="text-2xl font-semibold">Upload a CV version</h1>
      <form className="flex flex-col gap-4" onSubmit={handleSubmit}>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">Label</span>
          <input
            className="rounded border border-zinc-300 px-3 py-2"
            type="text"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="Software Engineer — Fintech"
            required
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-sm font-medium">File (PDF or DOCX)</span>
          <input
            className="rounded border border-zinc-300 px-3 py-2"
            type="file"
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            onChange={(event) => setFile(event.target.files?.[0] ?? null)}
            required
          />
        </label>
        <button
          className="rounded bg-foreground px-4 py-2 font-medium text-background disabled:opacity-50"
          type="submit"
          disabled={status === "requesting" || status === "uploading"}
        >
          {status === "requesting" || status === "uploading" ? "Uploading…" : "Upload"}
        </button>
        {status === "done" && <p className="text-sm text-green-600">Uploaded successfully.</p>}
        {error && <p className="text-sm text-red-600">{error}</p>}
      </form>
    </div>
  );
}
