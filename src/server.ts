import { app } from "./app.js";
import { env } from "./shared/config/env.js";

const server = app.listen(env.port, () => {
  console.log(`Server listening on port ${env.port} [${env.nodeEnv}]`);
});

export default server;
