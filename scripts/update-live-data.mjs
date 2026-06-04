import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const outputPath = join(__dirname, "..", "wc2026_live_data.js");

const endpoints = {
  groups: "https://worldcup26.ir/get/groups",
  teams: "https://worldcup26.ir/get/teams",
};

async function fetchJson(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "accept": "application/json",
        "user-agent": "wc2026-pages-updater/1.0",
      },
    });

    if (!response.ok) {
      throw new Error(`${url} returned ${response.status}`);
    }

    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function assertShape(data) {
  if (!data.groups || !Array.isArray(data.groups.groups)) {
    throw new Error("groups response shape changed");
  }
  if (!data.teams || !Array.isArray(data.teams.teams)) {
    throw new Error("teams response shape changed");
  }
}

const data = {
  fetchedAt: new Date().toISOString(),
  groups: await fetchJson(endpoints.groups),
  teams: await fetchJson(endpoints.teams),
};

assertShape(data);

const output = `window.WC2026_LIVE_DATA = ${JSON.stringify(data, null, 2)};\n`;
await writeFile(outputPath, output, "utf8");

console.log(`Updated ${outputPath}`);
console.log(`Fetched at ${data.fetchedAt}`);
