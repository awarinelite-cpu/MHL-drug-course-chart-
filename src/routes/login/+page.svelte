<script>
  import { signInWithEmailAndPassword, sendPasswordResetEmail } from "firebase/auth";
  import { auth } from "$lib/firebase.js";
  import { goto } from "$app/navigation";
  import wardBg from "$lib/assets/login-ward-bg.jpg";

  function friendlyError(e) {
    const code = e.code || "";
    if (code.includes("user-not-found") || code.includes("invalid-credential") || code.includes("wrong-password")) return "Incorrect email or password.";
    if (code.includes("too-many-requests")) return "Too many attempts. Please try again later.";
    if (code.includes("invalid-email")) return "Enter a valid email address.";
    // TEMP: surfacing the raw code so we can diagnose the Vercel deploy —
    // remove this line once login is confirmed working end-to-end.
    return "Something went wrong (" + (code || e.message || "no code") + "). Please try again.";
  }

  let email = $state("");
  let password = $state("");
  /** @type {HTMLInputElement | undefined} */
  let emailEl = $state();
  /** @type {HTMLInputElement | undefined} */
  let passwordEl = $state();
  /** @type {{type: 'error'|'info', text: string} | null} */
  let msg = $state(null);

  async function doLogin() {
    // Fall back to the actual DOM value in case the browser autofilled
    // the field without triggering the bind:value update (state would still be empty).
    const em = (email || emailEl?.value || "").trim();
    const pw = password || passwordEl?.value || "";
    email = em;
    password = pw;
    msg = null;
    if (!em || !pw) { msg = { type: "error", text: "Enter your email and password." }; return; }
    try {
      await signInWithEmailAndPassword(auth, em, pw);
      goto("/");
    } catch (e) {
      msg = { type: "error", text: friendlyError(e) };
    }
  }

  async function doReset() {
    const em = (email || emailEl?.value || "").trim();
    email = em;
    if (!em) { msg = { type: "error", text: 'Enter your email above first, then click "Forgot password?".' }; return; }
    try {
      await sendPasswordResetEmail(auth, em);
      msg = { type: "info", text: "Password reset link sent to " + em + ". Check your inbox (and spam folder)." };
    } catch (e) {
      msg = { type: "error", text: friendlyError(e) };
    }
  }
</script>

<div class="login-page" style="background-image:url({wardBg})">
  <div class="container" style="max-width:420px;margin-top:60px;">
    <div class="card-box login-card">
      <h2 style="text-align:center;margin-top:0;">MILITARY HOSPITAL LAGOS Ward Charts</h2>

      <div class="field">
        <label for="login-email">Email</label>
        <input id="login-email" type="email" placeholder="name@example.com" autocomplete="username"
          bind:this={emailEl} bind:value={email} />
      </div>
      <div class="field">
        <label for="login-password">Password</label>
        <input id="login-password" type="password" placeholder="Password" autocomplete="current-password"
          bind:this={passwordEl} bind:value={password}
          onkeydown={(e) => { if (e.key === "Enter") doLogin(); }} />
      </div>
      <button class="btn btn-primary" style="width:100%" onclick={doLogin}>Log In</button>

      <div style="text-align:center;margin-top:12px;">
        <a href="##" onclick={(e) => { e.preventDefault(); doReset(); }} style="font-size:13px;color:#2563eb;">Forgot password?</a>
      </div>
      {#if msg}
        <div class={msg.type === "error" ? "error-msg" : "info-msg"}>{msg.text}</div>
      {/if}
    </div>
  </div>
</div>
