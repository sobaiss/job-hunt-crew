"use client";

import { useCallback, useEffect, useState } from "react";

type Status = "idle" | "requesting" | "uploading" | "done" | "error";

type CVVersion = {
  id: string;
  label: string;
  fileName: string;
  fileType: "PDF" | "DOCX";
  isDefault: boolean;
  parseStatus: "PENDING" | "PARSING" | "PARSED" | "FAILED";
  createdAt: string;
};

export default function CvVersionsPage() {
  const [label, setLabel] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);

  const [cvVersions, setCvVersions] = useState<CVVersion[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [settingDefaultId, setSettingDefaultId] = useState<string | null>(null);

  const loadCvVersions = useCallback(async () => {
    try {
      const response = await fetch("/api/cv-versions");
      if (!response.ok) {
        throw new Error(`Request failed with ${response.status}`);
      }
      const { cvVersions } = await response.json();
      setCvVersions(cvVersions);
      setListError(null);
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to load CV versions");
    }
  }, []);

  useEffect(() => {
    // Fetching from the server on mount; not derivable from props/state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadCvVersions();
  }, [loadCvVersions]);

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
      setLabel("");
      setFile(null);
      await loadCvVersions();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Upload failed");
      setStatus("error");
    }
  }

  async function handleSetDefault(id: string) {
    setSettingDefaultId(id);
    setListError(null);
    try {
      const response = await fetch(`/api/cv-versions/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isDefault: true }),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || `Request failed with ${response.status}`);
      }
      await loadCvVersions();
    } catch (err) {
      setListError(err instanceof Error ? err.message : "Failed to set default");
    } finally {
      setSettingDefaultId(null);
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

      <h2 className="text-xl font-semibold">Your CV versions</h2>
      {listError && <p className="text-sm text-red-600">{listError}</p>}
      {cvVersions.length === 0 ? (
        <p className="text-sm text-zinc-500">No CV versions uploaded yet.</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {cvVersions.map((cv) => (
            <li
              key={cv.id}
              className="flex items-center justify-between rounded border border-zinc-300 px-3 py-2"
            >
              <div className="flex flex-col">
                <span className="font-medium">{cv.label}</span>
                <span className="text-xs text-zinc-500">
                  {cv.fileName} · {cv.fileType} · {cv.parseStatus}
                </span>
              </div>
              {cv.isDefault ? (
                <span className="rounded bg-green-100 px-2 py-1 text-xs font-medium text-green-700">
                  Default
                </span>
              ) : (
                <button
                  className="rounded border border-zinc-300 px-2 py-1 text-xs font-medium disabled:opacity-50"
                  onClick={() => handleSetDefault(cv.id)}
                  disabled={settingDefaultId === cv.id}
                  type="button"
                >
                  {settingDefaultId === cv.id ? "Setting…" : "Set as default"}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
