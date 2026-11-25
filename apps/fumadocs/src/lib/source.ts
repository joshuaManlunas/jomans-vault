import { llms, loader } from "fumadocs-core/source";
import { lucideIconsPlugin } from "fumadocs-core/source/lucide-icons";

import { docs } from "./collections";
import { openapi } from "./openapi";
import { docsRoute } from "./shared";

export const source = loader(
  {
    docs: docs.toFumadocsSource(),
    openapi: await openapi.staticSource({ baseDir: "api" }),
  },
  {
    baseUrl: docsRoute,
    plugins: [lucideIconsPlugin(), openapi.loaderPlugin()],
  }
);

export const docsLlms = llms(source, {
  renderPage: async (page) => {
    const title = `# ${page.data.title} (${page.url})`;
    if (page.type === "openapi") {
      const { operations = [] } = page.data.getOpenAPIPageProps();
      const { bundled } = page.data.getSchema();
      const content = operations.map(
        ({ method, path }) =>
          `## ${method.toUpperCase()} ${path}\n\n\`\`\`json\n${JSON.stringify(bundled.paths?.[path]?.[method], null, 2)}\n\`\`\``
      );
      return [title, ...content].join("\n\n");
    }
    return `${title}\n\n${await page.data.getText("processed")}`;
  },
});
