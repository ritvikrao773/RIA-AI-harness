// Verify `ria doctor` report collection (offline, no registry writes).
import { runDoctor, type DoctorOptions } from "../src/doctor.ts";
import { BUILTIN_PROVIDERS, type Config, type Provider } from "../src/config.ts";
import { riaBinDir } from "../src/pathinstall.ts";

let pass = 0, fail = 0;
const check = (n: string, c: boolean, d = "") => { if (c) { pass++; console.log(`  ok   ${n}`); } else { fail++; console.log(`  FAIL ${n} ${d}`); } };

// Deep-clone per case — configs share no state.
const clone = () => JSON.parse(JSON.stringify(BUILTIN_PROVIDERS)) as Record<string, Provider>;

// 1) healthy config: default deepseek keyed with models
const healthy: Config = {
  defaultProvider: "deepseek",
  defaultModel: "deepseek-chat",
  providers: clone(),
  skillsDirs: [],
};
healthy.providers.deepseek.apiKey = "sk-test";
const realBin = riaBinDir();
const opts: DoctorOptions = { version: "0.7.0", userPath: `C:\\somewhere;${realBin}` };
const r1 = runDoctor(healthy, opts);
check("healthy report is ok", r1.ok === true);
check("no fail rows", !r1.rows.some((r) => r.status === "fail"));
check("PATH row is ok", r1.rows.find((r) => r.label === "PATH")?.status === "ok");
check("default provider row is ok", r1.rows.find((r) => r.label === "default provider")?.status === "ok");
check("providers counted", /17 total/.test(r1.rows.find((r) => r.label === "providers")?.detail ?? ""));

// 2) default provider without a key → fail row, ok=false
const missing = runDoctor({ ...healthy, providers: clone() }, opts);
check("missing key is a fail", missing.rows.some((r) => r.status === "fail" && r.label === "default provider"));
check("missing key makes ok=false", missing.ok === false);

// 3) keyed default with no models → warn (not fail)
const noModels = JSON.parse(JSON.stringify(healthy)) as Config;
noModels.providers.deepseek.models = {};
const r3 = runDoctor(noModels, opts);
const dp3 = r3.rows.find((r) => r.label === "default provider");
check("no models is a warn, not a fail", dp3?.status === "warn" && r3.ok === true);
check("warn suggests Ria models", /Ria models deepseek/.test(dp3?.detail ?? ""));

// 4) PATH not registered → warn row
const r4 = runDoctor(healthy, { version: "0.7.0", userPath: "C:\\somewhere" });
check("PATH missing is a warn", r4.rows.find((r) => r.label === "PATH")?.status === "warn");
check("PATH warn keeps ok=true", r4.ok === true);

// 5) unknown default provider → fail
const r5 = runDoctor({ ...healthy, defaultProvider: "mesh_api", defaultModel: "x" }, opts);
check("unknown default is a fail", r5.rows.some((r) => r.status === "fail" && /not in providers/.test(r.detail)));

// 6) apiKeyCommand providers are listed without running them
const helper = JSON.parse(JSON.stringify(healthy)) as Config;
helper.providers.deepseek.apiKeyCommand = "echo test";
const r6 = runDoctor(helper, opts);
check("apiKeyCommand row lists the provider", /deepseek/.test(r6.rows.find((r) => r.label === "apiKeyCommand")?.detail ?? ""));

// 7) empty skills dirs → warn
const r7 = runDoctor({ ...healthy, skillsDirs: [] }, opts);
check("empty skills is a warn", r7.rows.find((r) => r.label === "skills")?.status === "warn");

// 8) renderDoctorReport: shared text for `ria doctor` and /doctor
const { renderDoctorReport } = await import("../src/doctor.ts");
const v = renderDoctorReport(healthy, opts);
check("render strips to rows + verdict", v.text.includes("default provider") && v.text.includes("all clear"));
check("render keeps ok flag", v.ok === true);
const v2 = renderDoctorReport({ ...healthy, defaultProvider: "nope" }, opts);
check("failed render says fix rows", v2.text.includes("fix the") && v2.ok === false);

// 9) model-list freshness joins the doctor report
const fresh = JSON.parse(JSON.stringify(healthy)) as Config;
fresh.providers.deepseek.modelsFetchedAt = new Date(Date.now() - 5 * 60_000).toISOString();
check("fresh list adds no stale row", !runDoctor(fresh, opts).rows.some((r) => r.label === "model lists"));
const stale = JSON.parse(JSON.stringify(healthy)) as Config;
stale.providers.deepseek.modelsFetchedAt = new Date(Date.now() - 3 * 86_400_000).toISOString();
const rs = runDoctor(stale, opts);
const staleRow = rs.rows.find((r) => r.label === "model lists");
check("stale list gets a warn row", staleRow?.status === "warn");
check("stale row names the provider + age", /deepseek \(3d ago\)/.test(staleRow?.detail ?? ""), staleRow?.detail);
check("stale list does not fail the report", rs.ok === true);

console.log(fail ? `\n${fail} FAIL / ${pass} ok` : `\nall ${pass} ok`);
process.exit(fail ? 1 : 0);
