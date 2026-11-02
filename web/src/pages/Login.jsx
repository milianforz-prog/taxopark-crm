import { useState } from "react";
import { supabase } from "../lib/supabase";

export default function Login() {
  const [mode, setMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setBusy(true);
    setMsg("");
    if (mode === "login") {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setMsg(error.message === "Invalid login credentials" ? "Неверный email или пароль" : error.message);
    } else if (mode === "signup") {
      const { data, error } = await supabase.auth.signUp({
        email, password,
        options: { data: { full_name: name }, emailRedirectTo: window.location.origin + window.location.pathname },
      });
      if (error) setMsg(error.message);
      else if (!data.session) setMsg("📧 Мы отправили письмо — подтвердите email и войдите.");
    } else {
      const { error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.origin + window.location.pathname,
      });
      setMsg(error ? error.message : "📧 Письмо со ссылкой для сброса пароля отправлено.");
    }
    setBusy(false);
  };

  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">🚕 Таксопарк CRM</div>
        <div className="tabs">
          <button type="button" className={mode === "login" ? "active" : ""} onClick={() => setMode("login")}>Вход</button>
          <button type="button" className={mode === "signup" ? "active" : ""} onClick={() => setMode("signup")}>Регистрация</button>
        </div>
        {mode === "signup" && (
          <input className="input" placeholder="Имя и фамилия" required value={name} onChange={(e) => setName(e.target.value)} />
        )}
        <input className="input" type="email" placeholder="Email" required autoComplete="email"
               value={email} onChange={(e) => setEmail(e.target.value)} />
        {mode !== "reset" && (
          <input className="input" type="password" placeholder="Пароль (от 6 символов)" required minLength={6}
                 autoComplete={mode === "login" ? "current-password" : "new-password"}
                 value={password} onChange={(e) => setPassword(e.target.value)} />
        )}
        <button className="btn primary" disabled={busy}>
          {mode === "login" ? "Войти" : mode === "signup" ? "Зарегистрироваться" : "Сбросить пароль"}
        </button>
        {mode === "login" && <button type="button" className="link small" onClick={() => setMode("reset")}>Забыли пароль?</button>}
        {msg && <div className="small">{msg}</div>}
        {mode === "signup" && <p className="muted small">После регистрации владелец парка должен одобрить доступ.</p>}
      </form>
    </div>
  );
}

export function SetPassword({ onDone }) {
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState("");
  const submit = async (e) => {
    e.preventDefault();
    const { error } = await supabase.auth.updateUser({ password });
    if (error) setMsg(error.message);
    else onDone();
  };
  return (
    <div className="login">
      <form className="login-card" onSubmit={submit}>
        <div className="logo">🔑 Новый пароль</div>
        <input className="input" type="password" minLength={6} required placeholder="Новый пароль"
               value={password} onChange={(e) => setPassword(e.target.value)} />
        <button className="btn primary">Сохранить</button>
        {msg && <div className="small">{msg}</div>}
      </form>
    </div>
  );
}
