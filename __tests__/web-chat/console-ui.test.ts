import { expect, test } from "bun:test";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  mkdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createConsoleHandler } from "../../src/web-chat/console";
import { OperatorController } from "../../src/web-chat/operator";
import { WebChatService } from "../../src/web-chat/service";
import { ADAPTER_VERSION } from "../../src/web-chat/types";
import type { BridgeConfig } from "../../src/web-chat/config";

async function consoleUi(remote = false) {
  const root = mkdtempSync(join(tmpdir(), "console-ui-"));
  const config: BridgeConfig = {
    accounts: ["claude", "chatgpt", "grok", "gemini"].map((service) => ({
      id: service,
      service: service as any,
      ...(service === "chatgpt"
        ? {
            validatedVersion: ADAPTER_VERSION,
            validatedService: "chatgpt" as const,
          }
        : {}),
    })),
    privateSources: [],
  };
  writeFileSync(join(root, "config.json"), JSON.stringify(config), {
    mode: 0o600,
  });
  let sends = 0,
    logins = 0,
    finishes = 0;
  const browser = {
    run: async (
      _conversation: any,
      prompt: string,
      signal: AbortSignal,
      submitted: (...args: any[]) => void,
    ) => {
      sends++;
      if (prompt.includes("cancel fixture")) {
        submitted("pending", "https://chatgpt.com/c/fixture");
        await new Promise<void>((_, reject) =>
          signal.addEventListener("abort", () => reject(Error("aborted")), {
            once: true,
          }),
        );
      }
      return {
        text: "<script>window.pwned=1</script>",
        turnId: "fixture",
        url: "https://chatgpt.com/c/fixture",
      };
    },
    reconcile: async () => ({
      state: "completed" as const,
      answer: {
        text: "Late fixture answer",
        turnId: "late",
        url: "https://chatgpt.com/c/fixture",
      },
    }),
    close: async () => {},
    login: async () => {
      logins++;
    },
    finishLogin: async () => {
      finishes++;
    },
  };
  const service = new WebChatService({
    root,
    accounts: config.accounts,
    browser,
  });
  const operator = new OperatorController({ root, config, service, browser });
  let handler!: ReturnType<typeof createConsoleHandler>;
  const server = Bun.serve({
    hostname: remote ? "0.0.0.0" : "127.0.0.1",
    port: 0,
    fetch: (request) => handler(request),
  });
  const origin = `http://${remote ? "console.tail.test" : "127.0.0.1"}:${server.port}`;
  handler = createConsoleHandler({
    root,
    origin,
    service,
    operator,
    allowRemote: remote,
  });
  const output = join(
    import.meta.dir,
    `../../openspec/changes/${remote ? "web-chat-tailscale" : "web-chat-console"}/evidence/ui`,
  );
  mkdirSync(output, { recursive: true });
  const script = `
    import { chromium } from ${JSON.stringify(pathToFileURL(Bun.resolveSync("playwright", import.meta.dir)).href)};
    import assert from 'node:assert/strict';
    let input=''; for await (const chunk of process.stdin) input+=chunk;
    const {origin,token,output,remote}=JSON.parse(input);
    const browser=await chromium.launch({headless:true,args:remote?['--host-resolver-rules=MAP console.tail.test 127.0.0.1','--no-proxy-server']:[]});
    try {
      const page=await browser.newPage({viewport:{width:1280,height:900}});
      const errors=[]; page.on('pageerror', e=>errors.push(e.message));
      await page.goto(origin);
      if(remote) {
        assert.equal(await page.evaluate(()=>isSecureContext),false);
        assert.equal(await page.evaluate(()=>typeof crypto.randomUUID),'undefined');
      }
      await page.getByLabel('Console token').fill(token);
      await page.getByRole('button',{name:'Unlock console',exact:true}).click();
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      for(const name of ['Claude','ChatGPT','Grok','Gemini']) await page.getByRole('heading',{name,exact:true}).waitFor();
      const claude=page.locator('[data-account="claude"]');
      await claude.getByRole('button',{name:'Open login',exact:true}).click();
      await claude.getByRole('button',{name:'Finish login',exact:true}).click();
      await claude.getByText('Unverified',{exact:true}).waitFor();
      await page.screenshot({animations:'disabled',path:output+'/connect.png'});
      await page.getByRole('button',{name:'Chat',exact:true}).click();
      assert.equal(await page.locator('#account option[value="claude"]').evaluate(n=>n.disabled),true);
      await page.getByLabel('Account').selectOption('chatgpt');
      const firstSendFailure=page.waitForEvent('pageerror').then(error=>{throw error;});
      await page.getByLabel('Message').fill('Public fixture question one');
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await Promise.race([
        page.locator('.answer').filter({hasText:'<script>window.pwned=1</script>'}).waitFor(),
        firstSendFailure,
      ]);
      assert.equal(await page.evaluate(()=>window.pwned),undefined);
      await page.reload();
      await page.locator('.answer').filter({hasText:'<script>window.pwned=1</script>'}).waitFor();
      await page.route('**/api/send',async route=>{
        const url=new URL(route.request().url());
        const headers={...route.request().headers(),host:url.host};
        if(remote) url.hostname='127.0.0.1';
        await route.fetch({url:url.href,headers});
        await route.abort('failed');
      });
      await page.getByLabel('Message').fill('Public fixture lost response');
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await page.waitForFunction(()=>document.querySelectorAll('.answer').length===2);
      await page.unroute('**/api/send');
      await page.reload();
      await page.waitForFunction(()=>document.querySelectorAll('.answer').length===2);
      await page.screenshot({animations:'disabled',path:output+'/chat.png'});
      await page.getByLabel('Message').fill('Public cancel fixture');
      await page.getByRole('button',{name:'Send',exact:true}).click();
      await page.getByRole('button',{name:'Cancel request',exact:true}).click();
      await page.getByRole('button',{name:'Check late answer',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'Lock console',exact:true}).click();
      await page.getByLabel('Console token').fill(token);
      await page.getByRole('button',{name:'Unlock console',exact:true}).click();
      await page.getByRole('button',{name:'Check late answer',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'Send',exact:true}).isDisabled(),true);
      await page.getByRole('button',{name:'Check late answer',exact:true}).click();
      await page.getByText('Late fixture answer',{exact:true}).waitFor();
      await page.setViewportSize({width:390,height:844});
      await page.screenshot({animations:'disabled',path:output+'/mobile.png'});
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      const box=await page.getByLabel('Message').boundingBox();
      assert.ok(box && box.x>=0 && box.x+box.width<=390 && box.height>=44);
      await page.getByRole('button',{name:'Connect',exact:true}).click();
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      await page.getByRole('button',{name:'Lock console',exact:true}).click();
      await page.getByRole('button',{name:'Unlock console',exact:true}).waitFor();
      assert.deepEqual(errors,[]);
      console.log('desktop/mobile, login lifecycle, safe text, reload, lost-response recovery, logout PASS');
    } finally {await browser.close();}
  `;
  try {
    const child = Bun.spawn(
      [Bun.which("node")!, "--input-type=module", "-e", script],
      {
        stdin: new Blob([
          JSON.stringify({
            origin,
            token: readFileSync(join(root, "operator-token"), "utf8").trim(),
            output,
            remote,
          }),
        ]),
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (code) throw Error(stderr || stdout);
    expect(stdout).toContain("logout PASS");
    expect(sends).toBe(3);
    expect(logins).toBe(1);
    expect(finishes).toBe(1);
  } finally {
    await server.stop(true);
    await operator.shutdown();
    await service.shutdown();
    rmSync(root, { recursive: true, force: true });
  }
}

test(
  "SC-2/SC-3/SC-6: real Chromium Chat/Connect, safe output, lost response recovery and mobile layout",
  () => consoleUi(),
  90_000,
);
test(
  "TS-3: non-secure remote HTTP supports real Chromium send and lost-response recovery",
  () => consoleUi(true),
  90_000,
);
