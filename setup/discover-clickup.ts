/**
 * Discover ClickUp workspace structure to find the correct list ID.
 */

import { listWorkspaces, listSpaces, listLists } from "../src/tools/clickup.ts";

console.log("Discovering ClickUp structure...\n");

const workspaces = await listWorkspaces();
if (!workspaces.length) {
  console.error("No workspaces found. Check your CLICKUP_API_KEY in .env");
  process.exit(1);
}

for (const ws of workspaces) {
  console.log(`Workspace: ${ws.name} (ID: ${ws.id})`);

  const spaces = await listSpaces(ws.id);
  for (const space of spaces) {
    console.log(`  Space: ${space.name} (ID: ${space.id})`);

    const lists = await listLists(space.id);
    for (const list of lists) {
      console.log(`    List: ${list.name} (ID: ${list.id}) <-- use this as CLICKUP_LIST_ID`);
    }
  }
}

console.log("\nCopy the list ID you want and set it as CLICKUP_LIST_ID in your .env");
