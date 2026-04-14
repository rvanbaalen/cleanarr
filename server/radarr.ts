type Fetch = typeof fetch;

export class RadarrClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetchFn: Fetch = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  private headers() {
    return { "X-Api-Key": this.apiKey, "Content-Type": "application/json" };
  }

  async ping(): Promise<{ ok: boolean; version?: string; error?: string }> {
    try {
      const res = await this.fetchFn(`${this.baseUrl}/api/v3/system/status`, {
        headers: this.headers(),
      });
      if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
      const data = (await res.json()) as { version?: string };
      return { ok: true, version: data.version };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  async findMovieByTmdbId(tmdbId: string | number): Promise<number | null> {
    const url = `${this.baseUrl}/api/v3/movie?tmdbId=${encodeURIComponent(String(tmdbId))}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) {
      throw new Error(`Radarr lookup failed: HTTP ${res.status}`);
    }
    const arr = (await res.json()) as Array<{ id: number }>;
    return arr.length > 0 ? arr[0].id : null;
  }

  async deleteMovie(
    id: number,
    opts: { deleteFiles: boolean; addImportExclusion: boolean },
  ): Promise<void> {
    const qs = new URLSearchParams({
      deleteFiles: String(opts.deleteFiles),
      addImportExclusion: String(opts.addImportExclusion),
    });
    const res = await this.fetchFn(
      `${this.baseUrl}/api/v3/movie/${id}?${qs.toString()}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Radarr delete failed: HTTP ${res.status} ${text}`);
    }
  }
}
