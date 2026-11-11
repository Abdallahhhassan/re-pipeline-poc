import express, { NextFunction, Request, Response } from "express";
import { ApiError } from "./errors";
import { wallets } from "./wallets";
import { transfers } from "./transfers";

const app = express();
app.use(express.json());
app.use(wallets);
app.use(transfers);

app.use((_req, _res, next) => next(new ApiError(404, "NOT_FOUND")));
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ApiError) {
    res.status(err.status).json({ error: err.code, ...err.extra });
  } else if (err?.type === "entity.parse.failed") {
    res.status(400).json({ error: "INVALID_JSON" });
  } else {
    console.error(err);
    res.status(500).json({ error: "INTERNAL" });
  }
});

const port = Number(process.env.PORT ?? 4001);
app.listen(port, () => console.log(`demo-target listening on ${port}`));
