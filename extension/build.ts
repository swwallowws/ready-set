import * as esbuild from "esbuild";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const production = process.argv.includes("--production");

// Inject the shared design system into the modal HTML at build time, so the
// website (tabridge/web) and this extension draw from ONE source of truth
// (shared/vendor/design, synced from ~/Playground/design, plus shared/roll.js
// and the design system's value box, the transpose control on the website).
// The modal is a data: URL and can't <link> anything, so the tokens are
// inlined and their font files embedded as base64 data URLs (otherwise the
// relative url("fonts/...") paths would 404).
const shared = path.join(here, "..", "shared");
const design = path.join(shared, "vendor", "design");
const tokensPlugin: esbuild.Plugin = {
  name: "html-with-tokens",
  setup(b) {
    b.onLoad({ filter: /interface\.html$/ }, async (args) => {
      const html = await fs.promises.readFile(args.path, "utf8");
      const tokens = (await fs.promises.readFile(path.join(design, "tokens.css"), "utf8")).replace(
        /url\("fonts\/([^"]+\.woff2)"\)/g,
        (_, f) => `url("data:font/woff2;base64,${fs.readFileSync(path.join(design, "fonts", f)).toString("base64")}")`,
      );
      if (/url\("fonts\//.test(tokens)) throw new Error("tokens.css has a font url that wasn't inlined");
      const roll = await fs.promises.readFile(path.join(shared, "roll.js"), "utf8");
      // The value box (the website's transpose control) ships as an ES module;
      // a data: URL modal can't import, so drop its `export`s and expose it as
      // window.DesignValueBox from a classic script.
      const vbCss = await fs.promises.readFile(path.join(design, "valuebox.css"), "utf8");
      const vbJs = (await fs.promises.readFile(path.join(design, "valuebox.js"), "utf8")).replace(/^export /gm, "");
      if (/^\s*(import|export)\b/m.test(vbJs)) throw new Error("valuebox.js has an import/export that wasn't inlined");
      const valuebox = `(function(){\n${vbJs}\nwindow.DesignValueBox = { valueBox };\n})();`;
      return {
        contents: html
          .replace("/*__TOKENS__*/", () => tokens)
          .replace("/*__VALUEBOX_CSS__*/", () => vbCss)
          .replace("/*__ROLL__*/", () => roll)
          .replace("/*__VALUEBOX__*/", () => valuebox),
        loader: "text",
      };
    });
  },
};

// The wasm-pack (nodejs) glue reads tabridge_bg.wasm off disk at load. The
// extensions packager only ships manifest + entry, so inline the wasm as base64
// into the bundle: no sidecar file, self-contained .ablx.
const inlineWasmPlugin: esbuild.Plugin = {
  name: "inline-wasm",
  setup(b) {
    b.onLoad({ filter: /pkg[\/\\]tabridge\.js$/ }, async (args) => {
      let js = await fs.promises.readFile(args.path, "utf8");
      const wasm = await fs.promises.readFile(
        path.join(path.dirname(args.path), "tabridge_bg.wasm"),
      );
      const b64 = wasm.toString("base64");
      js = js.replace(
        "const wasmBytes = require('fs').readFileSync(wasmPath);",
        `const wasmBytes = Buffer.from(${JSON.stringify(b64)}, "base64");`,
      );
      return { contents: js, loader: "js" };
    });
  },
};

await esbuild.build({
  entryPoints: ["src/extension.ts"],
  outfile: manifest.entry,
  bundle: true,
  format: "cjs",
  platform: "node",
  sourcesContent: false,
  logLevel: "info",
  minify: production,
  sourcemap: !production,
  // Live's Extension Host is a lean Node embedding that doesn't expose
  // TextDecoder/TextEncoder as globals, but the wasm-pack glue constructs them
  // at module init. Shim from node:util before any module code runs.
  banner: {
    js: "(()=>{const u=require('node:util');globalThis.TextDecoder=globalThis.TextDecoder||u.TextDecoder;globalThis.TextEncoder=globalThis.TextEncoder||u.TextEncoder;})();",
  },
  plugins: [tokensPlugin, inlineWasmPlugin],
});

// package.json here is "type":"module" (for tsx/import.meta in this build
// script), which would make Node treat the CJS bundle as ESM during local
// `npm start`. The packaged .ablx has no package.json so it loads as CJS fine,
// but mark dist/ as commonjs so the local dev host agrees.
fs.writeFileSync(
  path.join(path.dirname(manifest.entry), "package.json"),
  JSON.stringify({ type: "commonjs" }),
);
console.log("bundled dist/extension.js (wasm inlined, self-contained)");
