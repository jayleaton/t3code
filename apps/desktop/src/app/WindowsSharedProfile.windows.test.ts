/* eslint-disable t3code/no-global-process-runtime -- Runs the native Electron regression only on the host Windows OS. */
// @effect-diagnostics nodeBuiltinImport:off - native Electron encryption regression uses only disposable profiles and a synthetic credential.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";
import { sharedProfileRelaunchArgs } from "./WindowsSharedProfile.ts";

it.skipIf(process.platform !== "win32")(
  "restores both Windows credential formats across different app startup profiles",
  () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-profile-regression-"));
    const original = NodePath.join(root, "original");
    const fork = NodePath.join(root, "fork");
    const main = NodePath.join(root, "main.cjs");
    const runtime = NodeModule.createRequire(import.meta.url)("electron") as string;
    NodeFS.writeFileSync(
      main,
      `
    const {app,safeStorage}=require('electron');
    const fs=require('node:fs'),path=require('node:path');
    const root=process.env.T3_PROFILE_TEST_ROOT, phase=process.env.T3_PROFILE_TEST_PHASE;
    const original=path.join(root,'original');
    fs.mkdirSync(original,{recursive:true});
    // Reproduce the current application: setPath is correct, but native Windows
    // encryption has already opened the startup profile before JS executes.
    app.setPath('userData',original);
    app.whenReady().then(async()=>{
      const fixture=path.join(root,'credential.json');
      const result={};
      if(phase==='seed'){
        fs.writeFileSync(fixture,JSON.stringify({
          sync:safeStorage.encryptString('fixture').toString('base64'),
          async:(await safeStorage.encryptStringAsync('fixture')).toString('base64')
        }));
      }else{
        const data=JSON.parse(fs.readFileSync(fixture,'utf8'));
        try{result.sync=safeStorage.decryptString(Buffer.from(data.sync,'base64'))==='fixture';}catch{result.sync=false;}
        try{result.async=(await safeStorage.decryptStringAsync(Buffer.from(data.async,'base64'))).result==='fixture';}catch{result.async=false;}
      }
      fs.writeFileSync(path.join(root,phase+'.json'),JSON.stringify(result));app.exit(0);
    }).catch(()=>app.exit(1));
  `,
    );
    const run = (phase: string, args: readonly string[]) => {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        T3_PROFILE_TEST_ROOT: root,
        T3_PROFILE_TEST_PHASE: phase,
      };
      delete env.ELECTRON_RUN_AS_NODE;
      const child = NodeChildProcess.spawnSync(runtime, [main, ...args], {
        env,
        timeout: 30_000,
        windowsHide: true,
      });
      expect(child.error).toBeUndefined();
      expect(child.status, child.stderr?.toString()).toBe(0);
      return JSON.parse(NodeFS.readFileSync(NodePath.join(root, `${phase}.json`), "utf8"));
    };
    try {
      run("seed", [`--user-data-dir=${original}`]);
      expect(run("broken", [`--user-data-dir=${fork}`])).toEqual({ sync: false, async: false });
      const args = sharedProfileRelaunchArgs({
        platform: "win32",
        brand: "agents",
        isPackaged: true,
        isDevelopment: false,
        userDataPath: original,
        currentUserDataSwitch: fork,
        args: [`--user-data-dir=${fork}`],
      })!;
      expect(run("fixed", args)).toEqual({ sync: true, async: true });
      // A later launch sees state written by the other app, without copying files.
      run("seed", [`--user-data-dir=${original}`]);
      expect(run("again", args)).toEqual({ sync: true, async: true });
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  },
  120_000,
);
