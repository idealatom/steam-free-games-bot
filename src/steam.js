import { decodeHTML } from "entities";

const APP_ID_PATTERN = /^[1-9]\d*$/;
const PAGE_SIZE = 50;
const MAX_TOTAL_COUNT = 200;

function canonicalStoreUrl(appId) {
  return `https://store.steampowered.com/app/${appId}/`;
}

export async function parseSteamOffers(html) {
  let recognized = false;
  let currentRow;
  const offers = new Map();

  const rewriter = new HTMLRewriter()
    .on("#search_resultsRows, #search_results", {
      element() {
        recognized = true;
      },
    })
    .on("a.search_result_row", {
      element(element) {
        const row = {
          appId: element.getAttribute("data-ds-appid") ?? "",
          title: "",
          discount: "",
        };
        currentRow = row;
        element.onEndTag(() => {
          currentRow = undefined;
          const title = decodeHTML(row.title).replace(/\s+/g, " ").trim();
          if (
            APP_ID_PATTERN.test(row.appId) &&
            title &&
            row.discount.trim() === "-100%"
          ) {
            const appId = Number(row.appId);
            if (!offers.has(appId)) {
              offers.set(appId, {
                appId,
                title,
                url: canonicalStoreUrl(appId),
              });
            }
          }
        });
      },
    })
    .on("a.search_result_row .title", {
      text(text) {
        if (currentRow) {
          currentRow.title += text.text;
        }
      },
    })
    .on("a.search_result_row .discount_pct", {
      text(text) {
        if (currentRow) {
          currentRow.discount += text.text;
        }
      },
    });

  await rewriter.transform(new Response(html)).text();

  if (!recognized) {
    throw new Error("Steam response is not a search result");
  }

  return [...offers.values()].sort((left, right) => left.appId - right.appId);
}

export async function fetchSteamOffers(url) {
  const resultsUrl = new URL(url);
  resultsUrl.pathname = "/search/results/";
  resultsUrl.searchParams.set("count", String(PAGE_SIZE));
  resultsUrl.searchParams.set("dynamic_data", "");
  resultsUrl.searchParams.set("sort_by", "_ASC");
  resultsUrl.searchParams.set("infinite", "1");

  async function fetchSnapshot() {
    let totalCount;
    const offers = new Map();

    for (
      let start = 0;
      totalCount === undefined || start < totalCount;
      start += PAGE_SIZE
    ) {
      resultsUrl.searchParams.set("start", String(start));
      const response = await fetch(resultsUrl.toString(), {
        headers: {
          accept: "application/json",
          "user-agent":
            "Mozilla/5.0 (compatible; SteamFreeGamesBot/1.0; +https://workers.cloudflare.com/)",
        },
        signal: AbortSignal.timeout(15_000),
      });

      if (!response.ok) {
        throw new Error(`Steam request failed with HTTP ${response.status}`);
      }

      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error("Steam response is not valid JSON");
      }

      if (
        payload?.success !== 1 ||
        typeof payload.results_html !== "string" ||
        !Number.isSafeInteger(payload.total_count) ||
        payload.total_count < 0 ||
        payload.total_count > MAX_TOTAL_COUNT
      ) {
        throw new Error("Steam response has an invalid result payload");
      }
      if (totalCount !== undefined && payload.total_count !== totalCount) {
        throw new Error("Steam result count changed while fetching pages");
      }
      totalCount = payload.total_count;

      for (const offer of await parseSteamOffers(
        `<div id="search_resultsRows">${payload.results_html}</div>`,
      )) {
        offers.set(offer.appId, offer);
      }
    }

    if (offers.size !== totalCount) {
      throw new Error("Steam result rows do not match the reported count");
    }
    return [...offers.values()].sort((left, right) => left.appId - right.appId);
  }

  const firstSnapshot = await fetchSnapshot();
  if (firstSnapshot.length <= PAGE_SIZE) {
    return firstSnapshot;
  }

  const secondSnapshot = await fetchSnapshot();
  if (JSON.stringify(firstSnapshot) !== JSON.stringify(secondSnapshot)) {
    throw new Error("Steam results changed while fetching pages");
  }
  return secondSnapshot;
}
