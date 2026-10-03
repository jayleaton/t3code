/* eslint-disable t3code/no-global-process-runtime -- Opt-in native Electron regression, using disposable profiles and synthetic credentials. */
// @effect-diagnostics nodeBuiltinImport:off - this regression launches native Electron against disposable fixtures only.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { build } from "vite-plus/pack";
import { expect, it } from "vite-plus/test";

it.skipIf(process.env.T3CODE_NATIVE_STORAGE_TESTS !== "1")(
  "reads original and legacy fork credentials with native encryption, and writes credentials the original can read",
  async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-storage-regression-"));
    const entry = NodePath.join(root, "main.ts");
    const runtime = NodeModule.createRequire(import.meta.url)("electron") as string;
    const source = NodeURL.fileURLToPath(new URL("./SharedSafeStorage.ts", import.meta.url));
    NodeFS.writeFileSync(
      NodePath.join(root, "package.json"),
      JSON.stringify({ name: "t3agents", version: "1.0.0", main: "main.cjs" }),
    );
    NodeFS.writeFileSync(
      entry,
      `
      import { app, safeStorage } from 'electron';
      import * as NodeFS from 'node:fs';
      import { prepareSharedSafeStorage, decryptSharedString } from ${JSON.stringify(source)};
      const phase=process.env.T3_STORAGE_PHASE, root=process.env.T3_STORAGE_ROOT;
      if (process.platform === 'win32') app.setPath('appData',root+'/appdata');
      if (phase === 'broken' && !process.send || !prepareSharedSafeStorage()) {
        if (phase === 'legacy') app.setName('t3agents');
        if (phase === 'original') app.setName('t3code');
        app.whenReady().then(async()=>{
          try {
            const encrypt=async()=>({sync:safeStorage.encryptString('fixture').toString('base64'),async:(await safeStorage.encryptStringAsync('fixture')).toString('base64')});
            const read=name=>JSON.parse(NodeFS.readFileSync(root+'/'+name+'.json','utf8'));
            const result={};
            if (phase === 'original' || phase === 'legacy') {
              NodeFS.writeFileSync(root+'/'+phase+'.json',JSON.stringify(await encrypt()));
            } else if (phase === 'broken') {
              try { result.read=safeStorage.decryptString(Buffer.from(read('original').sync,'base64'))==='fixture'; } catch { result.read=false; }
            } else if (phase === 'original-read') {
              for (const [kind,value] of Object.entries(read('new'))) result[kind]=(kind==='sync' ? safeStorage.decryptString(Buffer.from(value,'base64')) : (await safeStorage.decryptStringAsync(Buffer.from(value,'base64'))).result)==='fixture';
            } else {
              app.setName('T3 Agents (Nightly)');
              for (const origin of ['original','legacy']) {
                for (const [kind,value] of Object.entries(read(origin))) result[origin+'-'+kind]=(await decryptSharedString(Buffer.from(value,'base64')))==='fixture';
              }
              NodeFS.writeFileSync(root+'/new.json',JSON.stringify(await encrypt()));
            }
            NodeFS.writeFileSync(root+'/'+phase+'-result.json',JSON.stringify(result)); app.quit();
          } catch { app.exit(1); }
        });
      }
    `,
    );
    try {
      await build({
        config: false,
        entry: [entry],
        outDir: root,
        clean: false,
        format: "cjs",
        outExtensions: () => ({ js: ".cjs" }),
        define: { __T3CODE_DESKTOP_BRAND__: JSON.stringify("agents") },
        deps: { neverBundle: ["electron"] },
      });
      const run = (phase: string) => {
        const env: NodeJS.ProcessEnv = {
          ...process.env,
          T3_STORAGE_ROOT: root,
          T3_STORAGE_PHASE: phase,
        };
        delete env.ELECTRON_RUN_AS_NODE;
        const child = NodeChildProcess.spawnSync(
          runtime,
          [
            root,
            `--user-data-dir=${
              process.platform === "win32"
                ? NodePath.join(
                    root,
                    "appdata",
                    phase === "legacy" || phase === "broken" ? "t3agents" : "t3code",
                  )
                : NodePath.join(root, "profile-" + phase)
            }`,
            ...(process.platform === "linux"
              ? ["--no-sandbox", "--password-store=gnome-libsecret"]
              : []),
          ],
          { env, timeout: 90_000 },
        );
        expect(child.error).toBeUndefined();
        expect(child.status, child.stderr?.toString()).toBe(0);
        return JSON.parse(NodeFS.readFileSync(NodePath.join(root, `${phase}-result.json`), "utf8"));
      };
      run("original");
      run("legacy");
      expect(run("broken")).toEqual({ read: false });
      expect(run("fixed")).toEqual({
        "original-sync": true,
        "original-async": true,
        "legacy-sync": true,
        "legacy-async": true,
      });
      expect(run("original-read")).toEqual({ sync: true, async: true });
      run("original");
      expect(run("fixed")).toEqual({
        "original-sync": true,
        "original-async": true,
        "legacy-sync": true,
        "legacy-async": true,
      });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
