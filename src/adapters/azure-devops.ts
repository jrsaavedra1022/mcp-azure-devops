import { z } from "zod";
import { RestClient } from "../client/rest-client.js";
const item = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
});
const variable = z.object({
  value: z.string().nullable().optional(),
  isSecret: z.boolean().optional(),
  allowOverride: z.boolean().optional(),
});
const environment = item.extend({
  rank: z.number().optional(),
  variables: z.record(variable).default({}),
  variableGroups: z.array(z.number()).default([]),
});
const definition = item.extend({
  revision: z.number().optional(),
  path: z.string().optional(),
  environments: z.array(environment).default([]),
  variables: z.record(variable).default({}),
  variableGroups: z.array(z.number()).default([]),
});
export type Definition = z.infer<typeof definition>;
export interface PageInput {
  top?: number;
  continuationToken?: string;
}
export interface DevOpsReader {
  organizations(memberId: string): Promise<{ id: string; name: string }[]>;
  projects(org: string, page: PageInput): Promise<unknown>;
  definitions(
    org: string,
    project: string,
    page: PageInput & { searchText?: string },
  ): Promise<unknown>;
  definition(org: string, project: string, id: number): Promise<Definition>;
}
export class AzureDevOpsAdapter implements DevOpsReader {
  constructor(private client: RestClient) {}
  async organizations(memberId: string) {
    const r = await this.client.get("profile", ["_apis", "accounts"], {
      memberId,
    });
    return z
      .object({
        value: z.array(
          z.object({ accountId: z.string(), accountName: z.string() }),
        ),
      })
      .parse(r.data)
      .value.map((a) => ({ id: a.accountId, name: a.accountName }));
  }
  async projects(org: string, page: PageInput) {
    const r = await this.client.get("core", [org, "_apis", "projects"], {
      $top: page.top ?? 50,
      continuationToken: page.continuationToken,
    });
    return {
      items: z.object({ value: z.array(item) }).parse(r.data).value,
      continuationToken: r.continuationToken,
    };
  }
  async definitions(
    org: string,
    project: string,
    page: PageInput & { searchText?: string },
  ) {
    const r = await this.client.get(
      "release",
      [org, project, "_apis", "release", "definitions"],
      {
        $top: page.top ?? 50,
        continuationToken: page.continuationToken,
        searchText: page.searchText,
      },
    );
    return {
      items: z
        .object({
          value: z.array(item.extend({ path: z.string().optional() })),
        })
        .parse(r.data).value,
      continuationToken: r.continuationToken,
    };
  }
  async definition(org: string, project: string, id: number) {
    const r = await this.client.get("release", [
      org,
      project,
      "_apis",
      "release",
      "definitions",
      String(id),
    ]);
    return definition.parse(r.data);
  }
}
