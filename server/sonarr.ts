type Fetch = typeof fetch;

type Series = {
  id: number;
  title: string;
  tvdbId: number;
  seasons: Array<{ seasonNumber: number; monitored: boolean }>;
};

type Episode = {
  id: number;
  seriesId: number;
  seasonNumber: number;
  episodeNumber: number;
  episodeFileId: number;
  monitored: boolean;
  hasFile: boolean;
};

export class SonarrClient {
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

  async findSeriesByTvdbId(tvdbId: string | number): Promise<Series | null> {
    const url = `${this.baseUrl}/api/v3/series?tvdbId=${encodeURIComponent(String(tvdbId))}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Sonarr series lookup failed: HTTP ${res.status}`);
    const arr = (await res.json()) as Series[];
    return arr.length > 0 ? arr[0] : null;
  }

  async getEpisodes(seriesId: number): Promise<Episode[]> {
    const url = `${this.baseUrl}/api/v3/episode?seriesId=${seriesId}`;
    const res = await this.fetchFn(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`Sonarr episode list failed: HTTP ${res.status}`);
    return (await res.json()) as Episode[];
  }

  async deleteEpisodeFile(episodeFileId: number): Promise<void> {
    if (episodeFileId <= 0) return; // nothing to delete
    const res = await this.fetchFn(
      `${this.baseUrl}/api/v3/episodefile/${episodeFileId}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sonarr episodefile delete failed: HTTP ${res.status} ${text}`);
    }
  }

  async deleteEpisodeFilesBulk(episodeFileIds: number[]): Promise<void> {
    const ids = episodeFileIds.filter((id) => id > 0);
    if (ids.length === 0) return;
    const res = await this.fetchFn(`${this.baseUrl}/api/v3/episodefile/bulk`, {
      method: "DELETE",
      headers: this.headers(),
      body: JSON.stringify({ episodeFileIds: ids }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sonarr bulk episodefile delete failed: HTTP ${res.status} ${text}`);
    }
  }

  async unmonitorEpisodes(episodeIds: number[]): Promise<void> {
    if (episodeIds.length === 0) return;
    const res = await this.fetchFn(`${this.baseUrl}/api/v3/episode/monitor`, {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify({ episodeIds, monitored: false }),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sonarr unmonitor failed: HTTP ${res.status} ${text}`);
    }
  }

  async setSeasonMonitored(
    seriesId: number,
    seasonNumber: number,
    monitored: boolean,
  ): Promise<void> {
    // Fetch current series, mutate the target season, PUT back
    const res = await this.fetchFn(`${this.baseUrl}/api/v3/series/${seriesId}`, {
      headers: this.headers(),
    });
    if (!res.ok) throw new Error(`Sonarr series fetch failed: HTTP ${res.status}`);
    const series = (await res.json()) as Series & Record<string, unknown>;
    let touched = false;
    for (const s of series.seasons) {
      if (s.seasonNumber === seasonNumber && s.monitored !== monitored) {
        s.monitored = monitored;
        touched = true;
      }
    }
    if (!touched) return;
    const put = await this.fetchFn(
      `${this.baseUrl}/api/v3/series/${seriesId}`,
      {
        method: "PUT",
        headers: this.headers(),
        body: JSON.stringify(series),
      },
    );
    if (!put.ok) {
      const text = await put.text().catch(() => "");
      throw new Error(`Sonarr series update failed: HTTP ${put.status} ${text}`);
    }
  }

  async deleteSeries(
    id: number,
    opts: { deleteFiles: boolean; addImportListExclusion: boolean },
  ): Promise<void> {
    const qs = new URLSearchParams({
      deleteFiles: String(opts.deleteFiles),
      addImportListExclusion: String(opts.addImportListExclusion),
    });
    const res = await this.fetchFn(
      `${this.baseUrl}/api/v3/series/${id}?${qs.toString()}`,
      { method: "DELETE", headers: this.headers() },
    );
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Sonarr series delete failed: HTTP ${res.status} ${text}`);
    }
  }
}
