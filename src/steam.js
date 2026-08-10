import { decodeHTML } from "entities";

const APP_ID_PATTERN = /^[1-9]\d*$/;

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
  const response = await fetch(url, {
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent":
        "Mozilla/5.0 (compatible; SteamFreeGamesBot/1.0; +https://workers.cloudflare.com/)",
    },
    signal: AbortSignal.timeout(15_000),
  });

  if (!response.ok) {
    throw new Error(`Steam request failed with HTTP ${response.status}`);
  }

  return parseSteamOffers(await response.text());
}
