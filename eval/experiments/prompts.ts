import { SYSTEM_PROMPT } from '../../src/app/prompt.js';

/** One complete example; no task answers or new mandatory tool sequence. */
export const EXAMPLE_PROMPT: string = `${SYSTEM_PROMPT}
Example for a requested file change (two replies):
await step("inspect", "find the requested setting", async () => { deposit(await read("settings.txt", "inspect current setting")); });
await step("update", "change and verify the setting", async () => { await edit("settings.txt", "update setting", {old:"enabled=false",new:"enabled=true"}); const text=await read("settings.txt", "verify change"); if(!text.includes("enabled=true")) throw Error("verification failed"); say("Updated and verified."); });`;
