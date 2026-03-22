# Host API Contract

The `host` object is the **only** interface between a generated widget and the outside world.
It is constructed by the runtime (App Block) and passed into `widget.mount(container, host)`.

---

## Entry Point

Every generated widget JS module must export a `mount` function:

```js
export function mount(container, host) {
  // container: the DOM element the widget owns — render inside here only
  // host: the only way to interact with the outside world
}
```

The runtime calls `mount` once on page load.

---

## The `host` Object

### `host.context`

Read-only page context populated by the runtime from the product page.

```js
host.context = {
  shop: "example.myshopify.com",     // always present
  productId: "123456789",            // present on product pages, null otherwise
  variantId: "987654321",            // currently selected variant, null if not applicable
  customerId: "111222333",           // logged-in customer, null if guest
}
```

### `host.call(path, body?)`

Make a POST request to your platform's backend. Returns a Promise.

```js
const result = await host.call("/features/waitlist/signup", {
  email: "shopper@example.com",
  variantId: host.context.variantId,
});
```

- `path` must be a relative path listed in the `platformApiCatalog` you received
- `body` is optional — omit for data-fetch calls, include for mutations
- Returns the JSON response from your platform
- Throws if the request fails (handle with try/catch)

### `host.getFormData(formElement)`

Reads all named inputs from a form element into a plain object.

```js
const form = container.querySelector("form");
const data = host.getFormData(form);
// { email: "...", name: "..." }
```

---

## Rules For Generated Widget Code

1. **Render only inside `container`** — never touch the DOM outside it
2. **No direct `fetch()`** — use `host.call()` for all backend requests
3. **No `window.*` access** — do not rely on global state
4. **No `eval()`, `Function()`, or dynamic execution**
5. **No `document.*` outside of `container.querySelector(...)` patterns**
6. **All backend paths must come from `platformApiCatalog`** — never hardcode URLs
7. **No hardcoded tenant or shop IDs** — read from `host.context`

---

## Example Widget

```js
export function mount(container, host) {
  container.innerHTML = `
    <form id="notify-form">
      <p>Get notified when this item is back in stock</p>
      <input type="email" name="email" placeholder="your@email.com" required />
      <button type="submit">Notify Me</button>
    </form>
    <p id="status" style="display:none"></p>
  `;

  const form = container.querySelector("#notify-form");
  const status = container.querySelector("#status");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const { email } = host.getFormData(form);
    try {
      await host.call("/features/waitlist/signup", {
        email,
        variantId: host.context.variantId,
      });
      form.style.display = "none";
      status.textContent = "You're on the list!";
      status.style.display = "block";
    } catch {
      status.textContent = "Something went wrong. Please try again.";
      status.style.display = "block";
    }
  });
}
```
