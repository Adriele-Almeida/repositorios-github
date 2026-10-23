import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2.117.1";

const GITHUB_USER = "Adriele-Almeida";
const TABLE = "repositorios-github";
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function displayName(repo: string) {
  return repo
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\p{L}/gu, (letter) => letter.toUpperCase());
}

type GithubRepo = {
  id: number;
  name: string;
  created_at: string | null;
  updated_at: string | null;
  has_pages: boolean;
};

type ExistingRow = {
  id: number;
  repo: string;
  github_id: number | null;
  name: string;
  favorite: boolean;
  added_at: string | null;
  github_created_at: string | null;
  github_updated_at: string | null;
};

function sameInstant(a: string | null, b: string | null) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return a === b;
  return ta === tb;
}

async function fetchAllRepos() {
  const repos: GithubRepo[] = [];
  for (let page = 1; page <= 20; page++) {
    const response = await fetch(
      `https://api.github.com/users/${GITHUB_USER}/repos?per_page=100&page=${page}&sort=created&direction=asc`,
      {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "repositorios-github-supabase-sync",
        },
      },
    );
    if (!response.ok) {
      throw new Error(`GitHub API ${response.status}: ${await response.text()}`);
    }
    const batch = await response.json() as GithubRepo[];
    repos.push(...batch);
    if (batch.length < 100) break;
  }
  return repos;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !serviceRole) {
      throw new Error("Supabase environment variables are unavailable");
    }

    const supabase = createClient(supabaseUrl, serviceRole, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const [{ data: existing, error: existingError }, githubRepos] = await Promise.all([
      supabase
        .from(TABLE)
        .select("id,repo,github_id,name,favorite,added_at,github_created_at,github_updated_at"),
      fetchAllRepos(),
    ]);
    if (existingError) throw existingError;

    const existingRows = (existing ?? []) as ExistingRow[];
    const existingByRepo = new Map(existingRows.map((row) => [row.repo, row]));
    const existingByGithubId = new Map(
      existingRows
        .filter((row) => row.github_id !== null)
        .map((row) => [row.github_id as number, row]),
    );
    const githubPagesRepos = githubRepos.filter((repo) => repo.has_pages);
    const retainedIds = new Set<number>();
    const rowsToWrite: Array<Record<string, unknown>> = [];
    const now = new Date().toISOString();
    let renamed = 0;
    let updated = 0;
    let inserted = 0;

    for (const repo of githubPagesRepos) {
      const byName = existingByRepo.get(repo.name);
      const current = existingByGithubId.get(repo.id) ??
        (byName?.github_id == null ? byName : undefined);
      if (!current) {
        rowsToWrite.push({
          repo: repo.name,
          github_id: repo.id,
          name: displayName(repo.name),
          favorite: false,
          added_at: now,
          github_created_at: repo.created_at,
          github_updated_at: repo.updated_at,
        });
        inserted++;
        continue;
      }

      retainedIds.add(current.id);
      const repoRenamed = current.repo !== repo.name;
      const changed =
        repoRenamed ||
        current.github_id !== repo.id ||
        !sameInstant(current.github_created_at, repo.created_at) ||
        !sameInstant(current.github_updated_at, repo.updated_at);

      if (changed) {
        rowsToWrite.push({
          id: current.id,
          repo: repo.name,
          github_id: repo.id,
          name: repoRenamed && current.name === displayName(current.repo)
            ? displayName(repo.name) : current.name,
          favorite: current.favorite,
          added_at: current.added_at,
          github_created_at: repo.created_at,
          github_updated_at: repo.updated_at,
        });
        updated++;
        if (repoRenamed) renamed++;
      }
    }


    // Build a rename plan before writing. Identity always follows github_id.
    const updates = rowsToWrite.filter((row) => row.id !== undefined);
    const inserts = rowsToWrite.filter((row) => row.id === undefined);
    const pending = updates.filter((row) => existingRows.find((old) => old.id === row.id)?.repo !== row.repo);
    const occupied = new Map(existingRows.map((row) => [row.repo, row.id]));
    const renamePlan: Array<{ id: number; repo: string }> = [];
    while (pending.length > 0) {
      let index = pending.findIndex((row) => !occupied.has(row.repo as string) || occupied.get(row.repo as string) === row.id);
      if (index < 0) {
        // Release a name in a rename cycle; deterministic ID preserves retry recovery.
        const row = pending[0];
        const temporary = `__github_sync_${row.id}`;
        if (occupied.has(temporary)) throw new Error("Temporary rename collision");
        const oldName = [...occupied].find(([, id]) => id === row.id)?.[0];
        if (oldName) occupied.delete(oldName);
        occupied.set(temporary, row.id as number);
        renamePlan.push({ id: row.id as number, repo: temporary });
        continue;
      }
      const row = pending.splice(index, 1)[0];
      const oldName = [...occupied].find(([, id]) => id === row.id)?.[0];
      if (oldName) occupied.delete(oldName);
      occupied.set(row.repo as string, row.id as number);
      renamePlan.push({ id: row.id as number, repo: row.repo as string });
    }
    for (const rename of renamePlan) {
      const { error } = await supabase.from(TABLE).update({ repo: rename.repo }).eq("id", rename.id);
      if (error) throw error;
    }
    // Update existing rows by their primary key, never by a recycled repository name.
    for (const row of updates) {
      const { id, favorite: _favorite, added_at: _addedAt, ...changes } = row;
      const { error } = await supabase.from(TABLE).update(changes).eq("id", id);
      if (error) throw error;
    }
    const idsToDelete = existingRows.filter((row) => !retainedIds.has(row.id)).map((row) => row.id);
    if (idsToDelete.length > 0) {
      const { error } = await supabase.from(TABLE).delete().in("id", idsToDelete);
      if (error) throw error;
    }
    if (inserts.length > 0) {
      const { error } = await supabase.from(TABLE).upsert(inserts, {
        onConflict: "repo", ignoreDuplicates: true,
      });
      if (error) throw error;
    }

    return new Response(
      JSON.stringify({
        ok: true,
        github_total: githubRepos.length,
        github_pages_total: githubPagesRepos.length,
        existing_total: existingRows.length,
        inserted,
        updated,
        renamed,
        deleted: idsToDelete.length,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error(error);
    return new Response(
      JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});