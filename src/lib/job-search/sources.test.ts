import { afterEach, describe, expect, it } from "vitest";

import { portalNames, rememberInstalledPortals, sourceInfo, type PortalInfo } from "./sources";

// A portal added from the catalog, as the setup guide's summary names it.
const himalayas: PortalInfo = {
  id: "HIMALAYAS",
  name: "Himalayas",
  description: "Remote jobs from Himalayas.",
  tag: "Remote · free, no key",
  keyUrl: null,
  quota: null,
  credit: { text: "Jobs from Himalayas", link: "https://himalayas.app" },
  countries: null,
  radius: false,
  kinds: ["any"],
  postingPage: null,
  maps: {},
};

afterEach(() => rememberInstalledPortals([]));

describe("sourceInfo", () => {
  it("names a built-in portal", () => {
    expect(sourceInfo("JSEARCH").name).toBe("JSearch");
  });

  it("names a portal added from the catalog by its own config", () => {
    rememberInstalledPortals([himalayas]);
    expect(sourceInfo("HIMALAYAS").name).toBe("Himalayas");
    expect(portalNames(["JSEARCH", "HIMALAYAS"])).toBe("JSearch and Himalayas");
  });

  it("keeps the id of a portal it doesn't know, rather than failing", () => {
    expect(sourceInfo("REMOVED_PORTAL").name).toBe("REMOVED_PORTAL");
  });
});
