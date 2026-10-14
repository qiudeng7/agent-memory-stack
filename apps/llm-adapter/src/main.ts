import { createLlmApp, llmOptionsFromEnv } from './app.js';
import { positiveInteger } from './common.js';
const bind = process.env.LLM_BIND ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(bind)) throw new Error('Unsupported LLM listen address');
const port = positiveInteger(process.env.LLM_PORT, 1455, 65535);
const app = await createLlmApp(llmOptionsFromEnv(process.env));
app.enableShutdownHooks();
await app.listen(port, bind);
console.info(`llm-gateway listening on ${bind}:${port}; live provider is disabled`);
