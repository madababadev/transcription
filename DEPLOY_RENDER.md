# Deploy the complete app on Render

The browser calls `/api/login`, `/api/me`, `/api/transcribe`, and other routes on the same origin as the frontend. These routes are implemented by `server.mjs`. A Render **Static Site** serves the built HTML and JavaScript but does not start that server. It can return an empty `200 OK` to `POST /api/login`, which makes the browser report an unreadable API response.

1. Push this repository with `Dockerfile` and `.dockerignore` to the branch you deploy.
2. In Render, create a **Web Service** from that repository. Choose **Docker** as the runtime and the repository root as the Docker context. The Dockerfile builds the frontend, installs the Python transcription worker, and starts `npm start`; no separate build or start commands are needed.
3. Choose a plan with at least 2 GB of RAM for the local ASR model. The 512 MB plans are too small for the approximately 584 MB model download plus Python, Node, and voice analysis. Check the plan's current price before creating the service.
4. Set `TRANSCRIPT_API_URL=https://transcription-api.5.189.188.129.sslip.io` in the Web Service environment. That existing account API uses PostgreSQL. Set `OPENAI_API_KEY` there too if you use **Polish dialogue**. Do not put `DATABASE_URL` or API keys in frontend build variables.
5. Set the Render health check path to `/api/health` and deploy. Open `https://<new-web-service>.onrender.com/api/health`; it must return JSON like `{"status":"ok","service":"mabab-transcription"}`. Then open the new Web Service URL and sign in. The login response must have `Content-Type: application/json` and a nonempty body containing `access_token` and `user`.

Use the new Web Service URL for the app. The existing Static Site at `https://transcription-fqx9.onrender.com/` will keep serving only static files until it is retired or replaced. Render assigns each new service its own URL.

The first transcription downloads the ASR and speaker models into `.models` in the Web Service container. A new container may need to download them again. Audio is sent to the Web Service for processing; only request usage details are saved by the PostgreSQL account API. If a model download or transcription fails, inspect the Web Service logs and available RAM.
