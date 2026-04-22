// Module-level constants in routes are evaluated at import time.
process.env["REDIS_HOST"] = "localhost";
process.env["REDIS_PORT"] = "6379";
process.env["NODE_ENV"] = "test";
