import path from "path";
import express, { NextFunction, Request, Response } from "express";
import { Fail } from "./http/fail";
import { routes } from "./http/routes";

const app = express();
app.use(express.json());
// The screens: same addresses, labels and messages as the original, our own look.
app.use(express.static(path.join(__dirname, "../public")));
app.use(routes);

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof Fail) {
    res.status(err.status).json({ error: err.code, ...err.details });
    return;
  }
  console.error(err);
  res.status(500).json({ error: "INTERNAL" });
});

const port = Number(process.env.PORT ?? 4002);
app.listen(port, () => console.log(`rebuilt service listening on ${port}`));
