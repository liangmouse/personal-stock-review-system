"use client";

import { useId, useRef, useState, useSyncExternalStore } from "react";

const subscribe = () => () => {};
const currentEndpoint = () => new URL("/mcp", window.location.origin).href;

export function McpConnection() {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const endpoint = useSyncExternalStore(subscribe, currentEndpoint, () => "/mcp");
  const [message, setMessage] = useState("");

  async function copy() {
    try {
      await navigator.clipboard.writeText(endpoint);
      setMessage("地址已复制");
    } catch {
      input.current?.select();
      setMessage("已选中地址，可手动复制");
    }
  }

  return (
    <details className="agent-connection" onToggle={() => setMessage("")}>
      <summary className="button button-secondary">连接 Agent</summary>
      <div className="agent-connection-panel">
        <label htmlFor={id}>MCP 服务器地址</label>
        <div className="agent-endpoint">
          <input readOnly ref={input} id={id} value={endpoint} onFocus={(event) => event.currentTarget.select()} />
          <button type="button" disabled={!endpoint} onClick={copy}>复制</button>
        </div>
        <p>在 ChatGPT 添加此服务器，选择 OAuth 授权。</p>
        <span role="status">{message}</span>
      </div>
    </details>
  );
}
