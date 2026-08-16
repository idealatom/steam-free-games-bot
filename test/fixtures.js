export const STEAM_SEARCH_URL =
  "https://store.steampowered.com/search/?hwtype=0&maxprice=free&category1=998&specials=1&ndl=1";

export const MOONLIGHTER = {
  appId: 606150,
  title: "Moonlighter",
  url: "https://store.steampowered.com/app/606150/",
};

export const BREATHEDGE = {
  appId: 738520,
  title: "Breathedge",
  url: "https://store.steampowered.com/app/738520/",
};

export const STEAM_RESULTS_HTML = `
  <html>
    <body>
      <div id="search_resultsRows">
        <a class="search_result_row ds_collapse_flag" data-ds-appid="738520"
           href="https://store.steampowered.com/app/738520/Breathedge/?snr=1_7_7_230_150_1">
          <span class="title">Breathedge</span>
          <div class="discount_pct">-100%</div>
        </a>
        <a class="search_result_row" data-ds-appid="606150"
           href="https://store.steampowered.com/app/606150/Moonlighter/">
          <span class="title">Moon<!-- force a text chunk -->lighter</span>
          <div class="discount_pct"> -100% </div>
        </a>
        <a class="search_result_row" data-ds-appid="999"
           href="https://store.steampowered.com/app/999/Ordinary_sale/">
          <span class="title">Ordinary sale</span>
          <div class="discount_pct">-90%</div>
        </a>
        <a class="search_result_row" data-ds-appid="1000"
           href="https://store.steampowered.com/app/1000/Free_to_play/">
          <span class="title">Free to play</span>
        </a>
        <a class="search_result_row" data-ds-appid="606150"
           href="https://store.steampowered.com/app/606150/Duplicate/">
          <span class="title">Duplicate row</span>
          <div class="discount_pct">-100%</div>
        </a>
      </div>
    </body>
  </html>
`;
