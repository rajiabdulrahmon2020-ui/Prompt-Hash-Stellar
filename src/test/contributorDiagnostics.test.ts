// @vitest-environment node
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  NETWORK_PASSPHRASES,
  applySafeFixes,
  checkDependencies,
  checkEnvironment,
  checkNetwork,
  checkSeedData,
  checkTooling,
  classifyUrl,
  formatReport,
  parseEnv,
  runDiagnostics,
  summarize,
} from "../../scripts/contributor-diagnostics.mjs";

const CONTRACT = "C" + "B".repeat(55);
const ACCOUNT = "G" + "B".repeat(55);
const KEY = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo=";

const goodEnv: Record<string, string> = {
  STELLAR_SCAFFOLD_ENV: "development",
  PUBLIC_STELLAR_NETWORK: "TESTNET",
  PUBLIC_STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.TESTNET,
  PUBLIC_STELLAR_RPC_URL: "https://soroban-testnet.stellar.org",
  PUBLIC_STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org",
  PUBLIC_PROMPT_HASH_CONTRACT_ID: CONTRACT,
  PUBLIC_STELLAR_NATIVE_ASSET_CONTRACT_ID: CONTRACT,
  PUBLIC_STELLAR_SIMULATION_ACCOUNT: ACCOUNT,
  PUBLIC_UNLOCK_PUBLIC_KEY: KEY,
  UNLOCK_PUBLIC_KEY: KEY,
  UNLOCK_PRIVATE_KEY: KEY,
  CHALLENGE_TOKEN_SECRET: "a-long-random-secret-value",
};

const ids = (checks: { id: string; status: string }[], status: string) =>
  checks.filter((c) => c.status === status).map((c) => c.id.split(":")[0]);

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, json: async () => body });

describe("checkEnvironment", () => {
  it("passes a consistent testnet config", () => {
    expect(ids(checkEnvironment(goodEnv), "fail")).toEqual([]);
  });

  it("fails on missing required vars", () => {
    const { CHALLENGE_TOKEN_SECRET, ...env } = goodEnv;
    void CHALLENGE_TOKEN_SECRET;
    expect(checkEnvironment(env).some((c) => c.id === "env.missing:CHALLENGE_TOKEN_SECRET")).toBe(true);
  });

  it("fails on the all-A placeholder contract id shipped in .env.example", () => {
    const env = { ...goodEnv, PUBLIC_PROMPT_HASH_CONTRACT_ID: "C" + "A".repeat(55) };
    expect(ids(checkEnvironment(env), "fail")).toContain("env.placeholder");
  });

  it("fails when the passphrase does not match the network", () => {
    const env = { ...goodEnv, PUBLIC_STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.PUBLIC };
    expect(ids(checkEnvironment(env), "fail")).toContain("env.network_passphrase");
  });

  it("fails when mainnet is configured with testnet endpoints", () => {
    const env = {
      ...goodEnv,
      PUBLIC_STELLAR_NETWORK: "PUBLIC",
      PUBLIC_STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.PUBLIC,
      STELLAR_SCAFFOLD_ENV: "production",
    };
    const fails = checkEnvironment(env).filter((c) => c.id === "env.url_network");
    expect(fails).toHaveLength(2);
  });

  it("accepts PUBLIC for mainnet and rejects the MAINNET spelling", () => {
    const env = {
      ...goodEnv,
      PUBLIC_STELLAR_NETWORK: "PUBLIC",
      PUBLIC_STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.PUBLIC,
      PUBLIC_STELLAR_RPC_URL: "https://mainnet.sorobanrpc.com",
      PUBLIC_STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      STELLAR_SCAFFOLD_ENV: "production",
    };
    expect(ids(checkEnvironment(env), "fail")).toEqual([]);
    expect(ids(checkEnvironment({ ...env, PUBLIC_STELLAR_NETWORK: "MAINNET" }), "fail")).toContain("env.format");
  });

  it("fails when frontend and serverless unlock public keys differ", () => {
    const env = { ...goodEnv, UNLOCK_PUBLIC_KEY: "ZGlmZmVyZW50LWtleS12YWx1ZS1oZXJl" };
    expect(ids(checkEnvironment(env), "fail")).toContain("env.unlock_keys");
  });

  it("fails on an impossible RPC quorum", () => {
    const env = {
      ...goodEnv,
      PUBLIC_STELLAR_RPC_URLS: "https://a.example,https://b.example",
      PUBLIC_STELLAR_ENTITLEMENT_QUORUM: "3",
    };
    expect(ids(checkEnvironment(env), "fail")).toContain("env.quorum");
  });

  it("warns on example secrets locally but fails on the public network", () => {
    const example = { CHALLENGE_TOKEN_SECRET: goodEnv.CHALLENGE_TOKEN_SECRET };
    expect(ids(checkEnvironment(goodEnv, { example }), "warn")).toContain("env.secret_default");
    const prod = {
      ...goodEnv,
      PUBLIC_STELLAR_NETWORK: "PUBLIC",
      PUBLIC_STELLAR_NETWORK_PASSPHRASE: NETWORK_PASSPHRASES.PUBLIC,
      PUBLIC_STELLAR_RPC_URL: "https://mainnet.sorobanrpc.com",
      PUBLIC_STELLAR_HORIZON_URL: "https://horizon.stellar.org",
      STELLAR_SCAFFOLD_ENV: "production",
    };
    expect(ids(checkEnvironment(prod, { example }), "fail")).toContain("env.secret_default");
  });

  it("never leaks secret values in results", () => {
    const dump = JSON.stringify(checkEnvironment({ ...goodEnv, CHALLENGE_TOKEN_SECRET: "short" }));
    expect(dump).not.toContain("short\"");
    expect(dump).not.toContain(KEY);
  });

  it("attaches a fix to every non-pass result", () => {
    const checks = checkEnvironment({ ...goodEnv, PUBLIC_STELLAR_NETWORK_PASSPHRASE: "nope" });
    for (const c of checks.filter((x) => x.status === "fail" || x.status === "warn")) {
      expect((c as { fix?: string }).fix, c.id).toBeTruthy();
    }
  });
});

describe("classifyUrl / parseEnv", () => {
  it("classifies hostnames by network", () => {
    expect(classifyUrl("https://soroban-testnet.stellar.org")).toBe("TESTNET");
    expect(classifyUrl("https://horizon.stellar.org")).toBe("PUBLIC");
    expect(classifyUrl("http://localhost:8000")).toBe("LOCAL");
    expect(classifyUrl("not a url")).toBeNull();
  });

  it("parses quotes and skips comments", () => {
    expect(parseEnv('# c\nA="x y"\nB=2\n')).toEqual({ A: "x y", B: "2" });
  });
});

describe("checkTooling", () => {
  const runner = (map: Record<string, string | null>) => (cmd: string) => map[cmd] ?? null;

  it("fails on old node and missing yarn", () => {
    const checks = checkTooling(runner({ "node --version": "v18.0.0" }));
    expect(ids(checks, "fail")).toEqual(expect.arrayContaining(["tool.node", "tool.yarn"]));
  });

  it("passes with a complete toolchain", () => {
    const checks = checkTooling(
      runner({
        "node --version": "v22.1.0",
        "yarn --version": "4.9.2",
        "rustc --version": "rustc 1.80.0",
        "cargo --version": "cargo 1.80.0",
        "rustup target list --installed": "wasm32-unknown-unknown",
        "stellar --version": "stellar 23.0.0",
        "git config user.name": "a",
        "git config user.email": "a@b.c",
      }),
    );
    expect(ids(checks, "fail")).toEqual([]);
    expect(ids(checks, "warn")).toEqual([]);
  });
});

describe("checkNetwork", () => {
  it("skips every probe offline", async () => {
    const checks = await checkNetwork({ ...goodEnv, MONGODB_URI: "mongodb://x/y" }, { offline: true });
    expect(checks.every((c) => c.status === "skip")).toBe(true);
  });

  it("passes when RPC and Horizon agree with the configured network", async () => {
    const fetchImpl = async (url: string, init?: { body?: string }) => {
      if (url.includes("soroban")) {
        const method = JSON.parse(init!.body!).method;
        return json({ result: method === "getHealth" ? { status: "healthy" } : { passphrase: NETWORK_PASSPHRASES.TESTNET } });
      }
      return json({ network_passphrase: NETWORK_PASSPHRASES.TESTNET });
    };
    const checks = await checkNetwork(goodEnv, { fetchImpl: fetchImpl as never });
    expect(ids(checks, "fail")).toEqual([]);
    expect(ids(checks, "pass")).toEqual(expect.arrayContaining(["net.rpc", "net.rpc_network", "net.horizon", "net.horizon_network"]));
  });

  it("fails when RPC is down and when it serves the wrong network", async () => {
    const down = await checkNetwork(goodEnv, {
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as never,
    });
    expect(ids(down, "fail")).toContain("net.rpc");

    const wrong = await checkNetwork(goodEnv, {
      fetchImpl: (async (url: string, init?: { body?: string }) =>
        url.includes("soroban")
          ? json({ result: JSON.parse(init!.body!).method === "getHealth" ? { status: "healthy" } : { passphrase: NETWORK_PASSPHRASES.PUBLIC } })
          : json({ network_passphrase: NETWORK_PASSPHRASES.PUBLIC })) as never,
    });
    expect(ids(wrong, "fail")).toEqual(expect.arrayContaining(["net.rpc_network", "net.horizon_network"]));
  });

  it("downgrades Horizon outage and unreachable Mongo to warnings", async () => {
    const checks = await checkNetwork(
      { ...goodEnv, MONGODB_URI: "mongodb://127.0.0.1:27017/x" },
      {
        fetchImpl: (async (url: string, init?: { body?: string }) => {
          if (url.includes("soroban")) return json({ result: { status: "healthy" } });
          void init;
          return json({}, false, 503);
        }) as never,
        probe: async () => false,
      },
    );
    expect(ids(checks, "warn")).toEqual(expect.arrayContaining(["net.horizon", "net.mongo"]));
    expect(ids(checks, "fail")).toEqual([]);
  });
});

describe("filesystem checks", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
  });

  function project(files: Record<string, string>) {
    const root = mkdtempSync(join(tmpdir(), "diag-"));
    dirs.push(root);
    for (const [name, body] of Object.entries(files)) {
      const full = join(root, name);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, body);
    }
    return root;
  }

  const seedFiles = {
    "src/test/fixtures/prompts.ts": "export {}",
    "src/test/fixtures/rareFailureFixtures.ts": "export {}",
    "tests/abi-conformance/fixtures/contract-spec.json": "{}",
    "server/scripts/seedPreview.mjs": "const blockedEnvironments = 1; const T='preview-seed-v1'",
  };

  it("passes seed checks for an intact tree", () => {
    expect(ids(checkSeedData(project(seedFiles)), "fail")).toEqual([]);
  });

  it("fails on corrupt ABI fixture and a seed script without its guardrail", () => {
    const root = project({
      ...seedFiles,
      "tests/abi-conformance/fixtures/contract-spec.json": "{oops",
      "server/scripts/seedPreview.mjs": "console.log('seed')",
    });
    expect(ids(checkSeedData(root), "fail")).toEqual(expect.arrayContaining(["seed.fixtures", "seed.script"]));
  });

  it("warns when the environment would block seeding", () => {
    const checks = checkSeedData(project(seedFiles), undefined, undefined, { NODE_ENV: "production" });
    expect(ids(checks, "warn")).toContain("seed.env_guard");
  });

  it("flags missing dependencies", () => {
    const checks = checkDependencies(project({}));
    expect(ids(checks, "fail")).toEqual(expect.arrayContaining(["deps.node_modules", "deps.lockfile"]));
  });

  it("--fix creates .env once and never overwrites an existing one", () => {
    const root = project({ ".env.example": "A=1" });
    expect(applySafeFixes(root)).toHaveLength(1);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("A=1");
    writeFileSync(join(root, ".env"), "A=custom");
    expect(applySafeFixes(root)).toEqual([]);
    expect(readFileSync(join(root, ".env"), "utf8")).toBe("A=custom");
    expect(existsSync(join(root, ".env.example"))).toBe(true);
  });

  it("runDiagnostics aggregates offline and reports failures with exit semantics", async () => {
    const root = project({
      ...seedFiles,
      ".env.example": "A=1",
      ".env": Object.entries(goodEnv).map(([k, v]) => `${k}=${v}`).join("\n"),
      "yarn.lock": "",
      "node_modules/.keep": "",
    });
    const run = (cmd: string) => ({ "node --version": "v22.0.0", "yarn --version": "4.9.2" })[cmd as "node --version"] ?? null;
    const report = await runDiagnostics({ root, processEnv: {}, run, offline: true });
    expect(report.summary.fail).toBe(0);
    expect(report.summary.ok).toBe(true);
    expect(summarize(report.checks, { strict: true }).ok).toBe(report.summary.warn === 0);
    expect(formatReport(report)).toContain("Diagnostics OK");

    const broken = await runDiagnostics({ root: project({}), processEnv: {}, run, offline: true });
    expect(broken.summary.ok).toBe(false);
    expect(formatReport(broken)).toContain("FAILED");
  });
});
