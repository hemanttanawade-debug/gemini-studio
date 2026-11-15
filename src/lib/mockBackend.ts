import type { DashboardUserRow } from "@/types/migration";

export function isMockBackendActive(): boolean {
  const configured = import.meta.env.VITE_API_URL?.trim();
  if (configured) return false;
  if (typeof window !== "undefined" && window.location.hostname === "migration.shivaami.in") {
    return false;
  }
  return true;
}

interface MockRun {
  runId: string;
  kind: "my-drive" | "shared-drive";
  status: "pending" | "running" | "completed" | "failed";
  startTime: string;
  endTime: string | null;
  totalUsers: number;
  filesTotal: number;
  filesDone: number;
  filesFailed: number;
  dataTotalGb: number;
  dataTransferredGb: number;
  userMapping: Record<string, string>;
  driveMapping: Record<string, string>;
  logs: string[];
  polls: number;
}

interface MockState {
  sessionId: string;
  sourceDomain: string;
  sourceAdminEmail: string;
  destinationDomain: string;
  destinationAdminEmail: string;
  sourceCredExists: boolean;
  destCredExists: boolean;
  migrationMode: string;
  lastDiscoveryRunId: string;
  lastSdDiscoveryRunId: string;
  userMappings: { sourceUser: string; destinationUser: string }[];
  sharedDriveMappings: Record<string, string>;
  runs: Map<string, MockRun>;
  activeRunId: string;
}

const STORAGE_KEY = "gws_mock_backend_v1";

function createFreshState(): MockState {
  return {
    sessionId: `sess_${Date.now().toString(36)}`,
    sourceDomain: "",
    sourceAdminEmail: "",
    destinationDomain: "",
    destinationAdminEmail: "",
    sourceCredExists: false,
    destCredExists: false,
    migrationMode: "custom",
    lastDiscoveryRunId: "",
    lastSdDiscoveryRunId: "",
    userMappings: [],
    sharedDriveMappings: {},
    runs: new Map(),
    activeRunId: "",
  };
}

function loadState(): MockState {
  const fresh = createFreshState();
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return fresh;
    const parsed = JSON.parse(raw);
    return {
      ...fresh,
      ...parsed,
      runs: new Map(Array.isArray(parsed.runs) ? parsed.runs : []),
    };
  } catch {
    return fresh;
  }
}

const state: MockState = loadState();

function saveState() {
  try {
    sessionStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        ...state,
        runs: Array.from(state.runs.entries()),
      })
    );
  } catch {
    /* ignore storage errors */
  }
}

function deterministicGb(seed: string): number {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 10000;
  }
  return Number((0.4 + (hash % 480) / 25).toFixed(2));
}

function parseCsvPairs(text: string): [string, string][] {
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const pairs: [string, string][] = [];
  for (let i = 0; i < lines.length; i++) {
    const cols = lines[i].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
    if (cols.length < 2) continue;
    if (i === 0 && (cols[0].toLowerCase().includes("source") || cols[1].toLowerCase().includes("dest"))) {
      continue;
    }
    if (cols[0] && cols[1]) {
      pairs.push([cols[0], cols[1]]);
    }
  }
  return pairs;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function advanceRun(run: MockRun) {
  if (run.status !== "running") return;
  run.polls += 1;
  const stepFiles = Math.max(1, Math.ceil(run.filesTotal / 4));
  const nextDone = Math.min(run.filesTotal, run.filesDone + stepFiles);
  const ratio = run.filesTotal > 0 ? nextDone / run.filesTotal : 1;
  run.filesDone = nextDone;
  run.dataTransferredGb = Number((run.dataTotalGb * ratio).toFixed(2));

  const users = Object.entries(
    run.kind === "shared-drive" ? run.driveMapping : run.userMapping
  );
  const sampleTarget = users.length > 0 ? users[(run.polls - 1) % users.length][0] : "workspace";
  run.logs.push(
    `[OK] ${sampleTarget} • Synced batch ${run.polls} (${run.filesDone}/${run.filesTotal} files)`
  );

  if (run.filesDone >= run.filesTotal) {
    run.status = "completed";
    run.endTime = new Date().toISOString();
    run.logs.push(`[DONE] Migration ${run.runId} completed (${run.filesDone} migrated, ${run.filesFailed} failed)`);
  }
  saveState();
}

export async function handleMockApi(path: string, options: RequestInit = {}): Promise<Response> {
  const method = (options.method || "GET").toUpperCase();
  const [pathname, queryStr] = path.split("?");
  const params = new URLSearchParams(queryStr || "");

  let bodyObj: Record<string, unknown> = {};
  if (options.body && typeof options.body === "string") {
    try {
      bodyObj = JSON.parse(options.body);
    } catch {
      bodyObj = {};
    }
  }

  // Auth verify
  if (pathname === "/api/auth/verify" && method === "POST") {
    return jsonResponse({
      email: "admin@shivaami.com",
      name: "Workspace Admin",
      picture: "",
    });
  }

  // Session creation
  if (pathname === "/api/config/new" && method === "POST") {
    state.sessionId = `sess_${Date.now().toString(36)}`;
    saveState();
    return jsonResponse({ sessionId: state.sessionId, message: "New session started" });
  }

  // Current config
  if (pathname === "/api/config/current" && method === "GET") {
    const activeRun = state.activeRunId ? state.runs.get(state.activeRunId) : undefined;
    return jsonResponse({
      sessionId: state.sessionId,
      sourceDomain: state.sourceDomain,
      sourceAdminEmail: state.sourceAdminEmail,
      destinationDomain: state.destinationDomain,
      destinationAdminEmail: state.destinationAdminEmail,
      migrationMode: state.migrationMode,
      lastDiscoveryRunId: state.lastDiscoveryRunId,
      lastSdDiscoveryRunId: state.lastSdDiscoveryRunId,
      sourceCredExists: state.sourceCredExists,
      destCredExists: state.destCredExists,
      csvExists: state.userMappings.length > 0,
      migrationActive: activeRun?.status === "running",
    });
  }

  // Save config
  if (pathname === "/api/config" && (method === "POST" || method === "PUT")) {
    if (options.body instanceof FormData) {
      const fd = options.body;
      state.sessionId = String(fd.get("sessionId") || state.sessionId);
      state.sourceDomain = String(fd.get("sourceDomain") || state.sourceDomain);
      state.sourceAdminEmail = String(fd.get("sourceAdminEmail") || state.sourceAdminEmail);
      state.destinationDomain = String(fd.get("destinationDomain") || state.destinationDomain);
      state.destinationAdminEmail = String(fd.get("destinationAdminEmail") || state.destinationAdminEmail);
      if (fd.get("sourceCredentials")) state.sourceCredExists = true;
      if (fd.get("destinationCredentials")) state.destCredExists = true;
    }
    saveState();
    return jsonResponse({
      success: true,
      message: "Configuration saved",
      sessionId: state.sessionId,
    });
  }

  // Preflight validation
  if (pathname === "/api/preflight" && method === "POST") {
    const hasDomains = Boolean(state.sourceDomain && state.destinationDomain);
    return jsonResponse({
      overall: hasDomains,
      checks: {
        service_account: {
          ok: state.sourceCredExists && state.destCredExists,
          message: state.sourceCredExists && state.destCredExists ? "Credentials loaded" : "Service account JSON missing",
          detail: "Verified service account key structure",
        },
        domain_delegation: {
          ok: hasDomains,
          message: hasDomains ? "Delegation verified" : "Domain configuration incomplete",
          detail: `${state.sourceAdminEmail} -> ${state.destinationAdminEmail}`,
        },
        cloud_sql: {
          ok: true,
          message: "Checkpoint store ready",
          detail: "In-memory checkpoint store active",
        },
        gcs_bucket: {
          ok: true,
          message: "Staging buffer ready",
          detail: "In-memory staging active",
        },
      },
    });
  }

  if (pathname === "/api/validate" && method === "POST") {
    return jsonResponse({ source: true, destination: true });
  }

  // User mapping CSV upload
  if (pathname === "/api/user-mapping" && method === "POST") {
    let pairs: [string, string][] = [];
    if (options.body instanceof FormData) {
      const file = options.body.get("file");
      if (file instanceof File) {
        pairs = parseCsvPairs(await file.text());
      }
    }
    state.userMappings = pairs.map(([sourceUser, destinationUser]) => ({
      sourceUser,
      destinationUser,
    }));
    saveState();
    return jsonResponse({ mappings: state.userMappings });
  }

  // Shared Drive mapping CSV upload
  if (pathname === "/api/shared-drive-mapping" && method === "POST") {
    let pairs: [string, string][] = [];
    if (options.body instanceof FormData) {
      const file = options.body.get("file");
      if (file instanceof File) {
        pairs = parseCsvPairs(await file.text());
      }
    }
    const mapping: Record<string, string> = {};
    for (const [src, dst] of pairs) mapping[src] = dst;
    state.sharedDriveMappings = mapping;
    saveState();
    return jsonResponse({ mapping, total: pairs.length });
  }

  // Storage sizes
  if (pathname === "/api/storage-sizes" && method === "POST") {
    const users: string[] = Array.isArray(bodyObj.users) ? bodyObj.users : [];
    const today = new Date().toISOString().slice(0, 10);
    const sizes: Record<string, { drive_gb: number; date: string; error: null }> = {};
    for (const u of users) {
      sizes[u] = { drive_gb: deterministicGb(u), date: today, error: null };
    }
    return jsonResponse({ sizes });
  }

  if (pathname === "/api/shared-drive/storage-sizes" && method === "POST") {
    const pairs: { source_drive_id: string; dest_drive_id: string }[] = Array.isArray(bodyObj.drive_pairs)
      ? bodyObj.drive_pairs
      : [];
    const rows = pairs.map((p) => {
      const gb = deterministicGb(p.source_drive_id);
      return {
        source_drive_id: p.source_drive_id,
        source_drive_name: `Drive ${p.source_drive_id.slice(0, 6)}`,
        source_total_bytes: Math.round(gb * 1024 ** 3),
        source_total_gb: gb,
        source_file_count: Math.round(gb * 240),
        source_error: null,
        dest_drive_id: p.dest_drive_id,
        dest_drive_name: `Dest ${p.dest_drive_id.slice(0, 6)}`,
        dest_total_bytes: 0,
        dest_total_gb: 0,
        dest_file_count: 0,
        dest_error: null,
      };
    });
    return jsonResponse({ rows });
  }

  // Migration mode
  if (pathname === "/api/migration-mode" && method === "POST") {
    state.migrationMode = String(bodyObj.mode || "custom");
    saveState();
    return jsonResponse({
      success: true,
      mode: state.migrationMode,
      message: "Migration mode saved",
    });
  }

  // Discovery (My Drive)
  if (pathname === "/api/discovery/start" && method === "POST") {
    const runId = String(bodyObj.runId || `run_${Date.now()}`);
    const userMapping: Record<string, string> = bodyObj.userMapping || {};
    const users = Object.keys(userMapping);
    const totalGb = users.reduce((acc, u) => acc + deterministicGb(u), 0);
    const totalFiles = Math.max(12, Math.round(totalGb * 180));
    const totalFolders = Math.max(4, Math.round(totalFiles * 0.08));
    const totalBytes = Math.round(totalGb * 1024 ** 3);

    state.lastDiscoveryRunId = runId;
    state.runs.set(runId, {
      runId,
      kind: "my-drive",
      status: "pending",
      startTime: new Date().toISOString(),
      endTime: null,
      totalUsers: users.length,
      filesTotal: totalFiles,
      filesDone: 0,
      filesFailed: 0,
      dataTotalGb: Number(totalGb.toFixed(2)),
      dataTransferredGb: 0,
      userMapping,
      driveMapping: state.sharedDriveMappings,
      logs: [`[INFO] Discovery scan completed for ${users.length} users (${totalFiles} files)`],
      polls: 0,
    });
    saveState();

    return jsonResponse({
      run_id: runId,
      totals: {
        total_users: users.length,
        completed_users: users.length,
        failed_users: 0,
        total_files: totalFiles,
        total_folders: totalFolders,
        total_size_bytes: totalBytes,
      },
      results: [],
    });
  }

  // Discovery (Shared Drive)
  if (pathname === "/api/shared-drive/discovery/start" && method === "POST") {
    const runId = String(bodyObj.runId || `run_sd_${Date.now()}`);
    const driveMapping: Record<string, string> = bodyObj.driveIdMapping || {};
    const drives = Object.keys(driveMapping);
    const totalGb = drives.reduce((acc, d) => acc + deterministicGb(d), 0);
    const totalFiles = Math.max(8, Math.round(totalGb * 150));
    const totalFolders = Math.max(2, Math.round(totalFiles * 0.07));
    const totalBytes = Math.round(totalGb * 1024 ** 3);

    state.lastSdDiscoveryRunId = runId;
    const existing = state.runs.get(runId);
    if (existing) {
      existing.driveMapping = driveMapping;
      existing.filesTotal += totalFiles;
      existing.dataTotalGb = Number((existing.dataTotalGb + totalGb).toFixed(2));
    } else {
      state.runs.set(runId, {
        runId,
        kind: "shared-drive",
        status: "pending",
        startTime: new Date().toISOString(),
        endTime: null,
        totalUsers: drives.length,
        filesTotal: totalFiles,
        filesDone: 0,
        filesFailed: 0,
        dataTotalGb: Number(totalGb.toFixed(2)),
        dataTransferredGb: 0,
        userMapping: {},
        driveMapping,
        logs: [`[INFO] Shared Drive scan completed for ${drives.length} drives (${totalFiles} files)`],
        polls: 0,
      });
    }
    saveState();

    return jsonResponse({
      run_id: runId,
      totals: {
        total_drives: drives.length,
        completed_drives: drives.length,
        failed_drives: 0,
        total_files: totalFiles,
        total_folders: totalFolders,
        total_size_bytes: totalBytes,
      },
      results: [],
    });
  }

  // Start migration (My Drive)
  if (pathname === "/api/migration/start" && method === "POST") {
    const runId = String(bodyObj.runId || state.lastDiscoveryRunId || `run_${Date.now()}`);
    const userMapping: Record<string, string> = bodyObj.userMapping || {};
    const existing = state.runs.get(runId);
    const run: MockRun = existing ?? {
      runId,
      kind: "my-drive",
      status: "running",
      startTime: new Date().toISOString(),
      endTime: null,
      totalUsers: Object.keys(userMapping).length,
      filesTotal: 120,
      filesDone: 0,
      filesFailed: 0,
      dataTotalGb: 2.5,
      dataTransferredGb: 0,
      userMapping,
      driveMapping: {},
      logs: [],
      polls: 0,
    };
    run.status = "running";
    run.userMapping = Object.keys(userMapping).length > 0 ? userMapping : run.userMapping;
    run.totalUsers = Object.keys(run.userMapping).length || run.totalUsers;
    run.logs.push(`[INFO] Started migration ${runId} for ${run.totalUsers} users`);
    state.runs.set(runId, run);
    state.activeRunId = runId;
    saveState();

    return jsonResponse({ run_id: runId, total_users: run.totalUsers });
  }

  // Start migration (Shared Drive)
  if (pathname === "/api/shared-drive/migrate/start" && method === "POST") {
    const runId = String(bodyObj.runId || state.lastSdDiscoveryRunId || `run_sd_${Date.now()}`);
    const driveMapping: Record<string, string> = bodyObj.driveIdMapping || state.sharedDriveMappings;
    const existing = state.runs.get(runId);
    const run: MockRun = existing ?? {
      runId,
      kind: "shared-drive",
      status: "running",
      startTime: new Date().toISOString(),
      endTime: null,
      totalUsers: Object.keys(driveMapping).length,
      filesTotal: 80,
      filesDone: 0,
      filesFailed: 0,
      dataTotalGb: 1.8,
      dataTransferredGb: 0,
      userMapping: {},
      driveMapping,
      logs: [],
      polls: 0,
    };
    run.status = "running";
    run.driveMapping = driveMapping;
    run.logs.push(`[INFO] Started Shared Drive migration ${runId}`);
    state.runs.set(runId, run);
    state.activeRunId = runId;
    saveState();

    return jsonResponse({ success: true, run_id: runId, message: "Shared drive migration started" });
  }

  // Resume migration
  if (pathname === "/api/migration/resume" && method === "POST") {
    const runId = String(bodyObj.runId || state.activeRunId);
    const run = state.runs.get(runId);
    if (run) {
      run.status = "running";
      run.logs.push(`[INFO] Resumed migration ${runId}`);
      state.activeRunId = runId;
      saveState();
      return jsonResponse({
        run_id: runId,
        total_users: run.totalUsers,
        pending_files: Math.max(0, run.filesTotal - run.filesDone),
        done_files: run.filesDone,
      });
    }
    return jsonResponse({ run_id: runId, total_users: 0, pending_files: 0, done_files: 0 });
  }

  if (pathname === "/api/shared-drive/migrate/resume" && method === "POST") {
    const runId = String(bodyObj.runId || state.activeRunId);
    const run = state.runs.get(runId);
    if (run) {
      run.status = "running";
      run.logs.push(`[INFO] Resumed shared drive migration ${runId}`);
      state.activeRunId = runId;
      saveState();
    }
    return jsonResponse({ success: true, run_id: runId, message: "Resumed" });
  }

  // Stream tokens (intentionally fallback to polling in preview mode)
  if (
    pathname === "/api/migration/stream-token" ||
    pathname === "/api/shared-drive/migrate/stream-token"
  ) {
    return jsonResponse({ error: "SSE unavailable — using status polling" }, 503);
  }

  // List runs
  if (pathname === "/api/migration/runs" && method === "GET") {
    const runs = Array.from(state.runs.values())
      .filter((r) => r.kind === "my-drive")
      .map((r) => ({
        run_id: r.runId,
        status: r.status,
        start_time: r.startTime,
        end_time: r.endTime,
        total_items: r.filesTotal,
        completed: r.filesDone,
        failed: r.filesFailed,
        pending: Math.max(0, r.filesTotal - r.filesDone - r.filesFailed),
        done: r.filesDone,
        source_domain: state.sourceDomain,
        dest_domain: state.destinationDomain,
        resumable: r.status !== "running" && r.filesDone < r.filesTotal,
      }));
    return jsonResponse({ runs });
  }

  if (pathname === "/api/shared-drive/migrate/runs" && method === "GET") {
    const runs = Array.from(state.runs.values())
      .filter((r) => r.kind === "shared-drive")
      .map((r) => ({
        run_id: r.runId,
        status: r.status,
        start_time: r.startTime,
        end_time: r.endTime,
        total_items: r.filesTotal,
        completed: r.filesDone,
        failed: r.filesFailed,
        pending: Math.max(0, r.filesTotal - r.filesDone - r.filesFailed),
        done: r.filesDone,
        source_domain: state.sourceDomain,
        dest_domain: state.destinationDomain,
        resumable: r.status !== "running" && r.filesDone < r.filesTotal,
      }));
    return jsonResponse({ runs });
  }

  // Migration status
  if (pathname === "/api/migration/status" && method === "GET") {
    const runId = params.get("run_id") || state.activeRunId;
    const run = runId ? state.runs.get(runId) : undefined;
    if (!run) {
      return jsonResponse({ run_id: runId, status: "pending", totals: {}, logs: [] });
    }
    advanceRun(run);
    return jsonResponse({
      run_id: run.runId,
      status: run.status,
      totals: {
        total_users: run.totalUsers,
        files_migrated: run.filesDone,
        files_failed: run.filesFailed,
        files_done: run.filesDone,
        files_total: run.filesTotal,
        data_transferred_gb: run.dataTransferredGb,
        data_total_gb: run.dataTotalGb,
      },
      logs: run.logs,
    });
  }

  if (pathname === "/api/shared-drive/migrate/status" && method === "GET") {
    const runId = params.get("run_id") || state.activeRunId;
    const run = runId ? state.runs.get(runId) : undefined;
    if (!run) {
      return jsonResponse({ run_id: runId, status: "pending", totals: {}, logs: [] });
    }
    advanceRun(run);
    return jsonResponse({
      run_id: run.runId,
      status: run.status,
      totals: {
        drives_total: Object.keys(run.driveMapping).length || run.totalUsers,
        drives_done: run.status === "completed" ? Object.keys(run.driveMapping).length : 0,
        files_migrated: run.filesDone,
        files_failed: run.filesFailed,
        files_ignored: 0,
        folders_created: Math.round(run.filesDone * 0.08),
      },
      logs: run.logs,
    });
  }

  // Dashboard
  if (pathname === "/api/dashboard" && method === "GET") {
    const runId = params.get("run_id") || state.activeRunId;
    const run = runId ? state.runs.get(runId) : undefined;
    const entries = run
      ? Object.entries(run.userMapping)
      : state.userMappings.map((m) => [m.sourceUser, m.destinationUser] as [string, string]);

    const ratio = run && run.filesTotal > 0 ? run.filesDone / run.filesTotal : 0;
    const rows: DashboardUserRow[] = entries.map(([src, dst]) => {
      const sizeTotalGb = deterministicGb(src);
      const filesTotal = Math.max(10, Math.round(sizeTotalGb * 180));
      const filesDone = run ? Math.round(filesTotal * ratio) : 0;
      const progressPct = filesTotal > 0 ? Math.min(100, Math.round((filesDone / filesTotal) * 100)) : 0;
      const status: DashboardUserRow["status"] = !run
        ? "pending"
        : run.status === "completed"
          ? "completed"
          : run.status === "failed"
            ? "failed"
            : "running";

      return {
        sourceUser: src,
        destinationUser: dst,
        status,
        progressPct,
        filesDone,
        filesTotal,
        filesFailed: 0,
        sizeDoneGb: Number((sizeTotalGb * ratio).toFixed(2)),
        sizeTotalGb,
      };
    });

    const completed = rows.filter((r) => r.status === "completed").length;
    const inProgress = rows.filter((r) => r.status === "running").length;
    const failed = rows.filter((r) => r.status === "failed").length;

    return jsonResponse({
      totalUsers: rows.length,
      completed,
      inProgress,
      failed,
      filesMigrated: run?.filesDone ?? 0,
      filesTotal: run?.filesTotal ?? rows.reduce((a, r) => a + r.filesTotal, 0),
      dataTransferredGb: run?.dataTransferredGb ?? 0,
      dataTotalGb: run?.dataTotalGb ?? Number(rows.reduce((a, r) => a + r.sizeTotalGb, 0).toFixed(2)),
      rows,
    });
  }

  // Export SQL report / logs
  if (pathname === "/api/export/sql" && method === "GET") {
    const runId = params.get("run_id") || state.activeRunId || "migration";
    const run = state.runs.get(runId);
    const csvContent = [
      "run_id,status,files_done,files_total,data_transferred_gb,data_total_gb",
      `${runId},${run?.status ?? "pending"},${run?.filesDone ?? 0},${run?.filesTotal ?? 0},${run?.dataTransferredGb ?? 0},${run?.dataTotalGb ?? 0}`,
    ].join("\n");
    return new Response(csvContent, {
      status: 200,
      headers: { "Content-Type": "text/csv" },
    });
  }

  if (pathname === "/api/export/logs" && method === "GET") {
    const runId = params.get("run_id") || state.activeRunId;
    const run = runId ? state.runs.get(runId) : undefined;
    const txt = (run?.logs ?? ["No logs recorded yet."]).join("\n");
    return new Response(txt, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // Reset
  if (pathname === "/api/reset" && method === "DELETE") {
    const runCount = state.runs.size;
    const fresh = createFreshState();
    Object.assign(state, fresh);
    state.runs.clear();
    saveState();
    return jsonResponse({
      success: true,
      new_session_id: state.sessionId,
      files_deleted: ["credentials.json", "users.csv", "session.json"],
      sql: {
        runs_deleted: runCount,
        items_deleted: 0,
        folders_deleted: 0,
        permissions_deleted: 0,
        users_deleted: 0,
        error: null,
      },
    });
  }

  return jsonResponse({ error: `Unhandled route: ${method} ${pathname}` }, 404);
}
