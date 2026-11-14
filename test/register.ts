// Resolve `.js` specifiers to their `.ts` sources so tests run without a build.
import { register } from "node:module";
import { pathToFileURL } from "node:url";

register(
  "data:text/javascript," +
    encodeURIComponent(`
      export async function resolve(specifier, context, next) {
        if (specifier.startsWith(".") && specifier.endsWith(".js")) {
          try { return await next(specifier.slice(0, -3) + ".ts", context); } catch {}
        }
        return next(specifier, context);
      }
    `),
  pathToFileURL("./"),
);
