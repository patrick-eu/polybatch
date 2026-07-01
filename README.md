# PolyBatch

**One-click batch buying across multiple Polymarket options.** Pick several bins in a market, set direction (YES/NO) and share size, see the combined cost live, and place all the orders in one flow — instead of clicking through each one by hand.

> ⚠️ **Unofficial.** PolyBatch is an independent, community-built tool. It is **not affiliated with, endorsed by, or connected to Polymarket** in any way.

## How it works — and why it's safe

PolyBatch **never touches your private keys or your funds.** It doesn't sign anything and it has no backend server.

Instead, it drives Polymarket's own interface: it fills in the price and size and clicks *Place order* for each option, so the wallet **you** have already connected to Polymarket signs each order — exactly as if you did it yourself. Because signing is delegated entirely to your connected wallet, PolyBatch works with **any** wallet Polymarket supports (MetaMask, Magic email login, Phantom, etc.).

Everything runs locally in your browser. It's open source so you can verify all of this yourself.

## Install

**From source (load unpacked):**

1. Download this repository (Code → Download ZIP, or `git clone`).
2. Open `chrome://extensions` in Chrome.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the project folder.
5. Open any Polymarket market — the PolyBatch panel appears on the right.

The prebuilt `polybatch-ext.zip` in this repo is the same thing, zipped.

## Usage

1. Go to a Polymarket event page with multiple options.
2. In the PolyBatch panel: choose **YES** or **NO**, set shares per option, and check the options you want.
3. Review the combined cost (green = profitable, red = will lose).
4. Click **Place orders** and sign each order in your wallet as it pops up.

Close the panel with the **×**; bring it back anytime by clicking the PolyBatch toolbar icon.

### Pricing note

Orders are placed as **limit orders priced to fill your requested size through the order book** — if your size is larger than the best ask, the limit is set high enough to sweep the deeper levels, and Polymarket fills the cheaper ones first. Size beyond the total available depth may not fill.

## Privacy

No data collected, no tracking, no keys, no funds. See [PRIVACY.md](PRIVACY.md).

## Support development ♥

PolyBatch is **free to use, forever.** If it saves you time, a tip helps keep it maintained:

- **Polygon (EVM · USDC / USDT / POL):** `0xFe4446C8f8BfDEACe3696B0D84FD8e271fd61Eb9`
- **TRON (TRC20 · USDT):** `TLxkofLRboA279JwkY9H5jXWWeUPeNeagS`

_Send only on the matching network. Donations are voluntary and non-refundable._

## Disclaimer

PolyBatch places real orders that spend real money on Polymarket. You are solely responsible for every order you place with it. The software is provided "as is", without warranty of any kind. Use at your own risk, and only where prediction markets are legal for you.

## License

[MIT](LICENSE)
