import dotenv from "dotenv";
import path from "path";

dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../.env") });

async function main() {
  const apiKey = process.env.NVIDIA_NIM_API_KEY;
  const model = process.env.NVIDIA_NIM_MODEL || "nvidia/nemotron-3.5-lightning-30b-a3b";
  console.log(`API Key: ${apiKey ? "present (" + apiKey.slice(0, 10) + "...)" : "MISSING"}`);
  console.log(`Model: ${model}`);

  const start = Date.now();
  try {
    const response = await fetch("https://integrate.api.nvidia.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: "You are a diagnostic agent. Return ONLY valid JSON." },
          { role: "user", content: "A pod is in ImagePullBackOff. Return: {\"actionType\":\"update_image\",\"target\":\"deployment/test\",\"params\":{\"image\":\"nginx:alpine\"},\"reasoning\":\"Bad image tag\"}" },
        ],
        temperature: 0.1,
        max_tokens: 200,
      }),
    });

    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`HTTP ${response.status} ${response.statusText} (${elapsed}s)`);

    const text = await response.text();
    console.log("Response body (first 500 chars):");
    console.log(text.slice(0, 500));
  } catch (err: any) {
    const elapsed = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`FAILED after ${elapsed}s: ${err.message}`);
    console.log(err);
  }
}

main().catch(console.error);