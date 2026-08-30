"use client";

import { useEffect, useState } from "react";

type SiteConfig = {
  id: string;
  siteKey: string;
  displayName: string;
};

const POSTED_WITHIN_OPTIONS = ["24h", "7d", "14d", "30d", "any"] as const;
const REMOTE_OPTIONS = ["onsite", "hybrid", "remote"] as const;

export default function NewSiteSearchIngestionJobPage() {
  const [siteConfigs, setSiteConfigs] = useState<SiteConfig[]>([]);
  const [siteConfigId, setSiteConfigId] = useState("");
  const [keywords, setKeywords] = useState("");
  const [location, setLocation] = useState("");
  const [postedWithin, setPostedWithin] = useState<(typeof POSTED_WITHIN_OPTIONS)[number]>("any");
  const [contractType, setContractType] = useState("");
  const [remote, setRemote] = useState<"" | (typeof REMOTE_OPTIONS)[number]>("");
  const [experienceLevel, setExperienceLevel] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdJobId, setCreatedJobId] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const response = await fetch("/api/site-configs");
        if (!response.ok) {
          throw new Error(`Request failed with ${response.status}`);
        }
        const { siteConfigs } = await response.json();
        setSiteConfigs(siteConfigs);
        if (siteConfigs.length > 0) {
          setSiteConfigId(siteConfigs[0].id);
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to load sites");
      }
    })();
  }, []);

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setCreatedJobId(null);
    try {
      const response = await fetch("/api/ingestion-jobs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "SITE_SEARCH",
          siteConfigId,
          filters: {
            keywords: keywords || undefined,
            location: location || undefined,
            postedWithin,
            contractType: contractType || undefined,
            remote: remote || undefined,
            experienceLevel: experienceLevel || undefined,
          },
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data.error ?? `Request failed with ${response.status}`);
      }
      setCreatedJobId(data.ingestionJob.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start ingestion");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <h1>Search a Job Site</h1>
      <form onSubmit={handleSubmit}>
        <label htmlFor="site">Site</label>
        <select
          id="site"
          value={siteConfigId}
          onChange={(e) => setSiteConfigId(e.target.value)}
          required
        >
          {siteConfigs.map((site) => (
            <option key={site.id} value={site.id}>
              {site.displayName}
            </option>
          ))}
        </select>

        <label htmlFor="keywords">Keywords</label>
        <input
          id="keywords"
          type="text"
          value={keywords}
          onChange={(e) => setKeywords(e.target.value)}
        />

        <label htmlFor="location">Location</label>
        <input
          id="location"
          type="text"
          value={location}
          onChange={(e) => setLocation(e.target.value)}
        />

        <label htmlFor="postedWithin">Posted within</label>
        <select
          id="postedWithin"
          value={postedWithin}
          onChange={(e) =>
            setPostedWithin(e.target.value as (typeof POSTED_WITHIN_OPTIONS)[number])
          }
        >
          {POSTED_WITHIN_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <label htmlFor="contractType">Contract type</label>
        <input
          id="contractType"
          type="text"
          value={contractType}
          onChange={(e) => setContractType(e.target.value)}
        />

        <label htmlFor="remote">Remote policy</label>
        <select
          id="remote"
          value={remote}
          onChange={(e) => setRemote(e.target.value as "" | (typeof REMOTE_OPTIONS)[number])}
        >
          <option value="">Any</option>
          {REMOTE_OPTIONS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>

        <label htmlFor="experienceLevel">Experience level</label>
        <input
          id="experienceLevel"
          type="text"
          value={experienceLevel}
          onChange={(e) => setExperienceLevel(e.target.value)}
        />

        <button type="submit" disabled={submitting || !siteConfigId}>
          {submitting ? "Starting…" : "Search"}
        </button>
      </form>

      {error && <p role="alert">{error}</p>}
      {createdJobId && (
        <p>
          Ingestion job created:{" "}
          <a href={`/ingestion-jobs/${createdJobId}`}>{createdJobId}</a>
        </p>
      )}
    </main>
  );
}
