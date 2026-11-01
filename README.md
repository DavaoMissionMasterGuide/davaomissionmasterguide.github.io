# Davao Mission — Master Guide Registry

A free online system that tracks every Master Guide in Davao Mission, from enrolment to investiture.

| Part | What it is | Where it lives (free) |
|---|---|---|
| **Public website** (`index.html`) | Anyone can search names and see the stage, progress bar and document count | GitHub Pages |
| **Admin website** (`admin.html`) | Director and Cluster Coordinators sign in to add and edit records | GitHub Pages |
| **Backend** (`apps-script/Code.gs`) | Logins, permissions, saving data | Google Apps Script |
| **Data** | One Google Sheet (Members, Stages, Documents, Clusters, Users, Settings, Log) | Your Google Drive |
| **Certificates** | Private Drive folder; the public **never** sees them | Your Google Drive |

You only need **one Google account** (best: a dedicated Gmail for the Mission's Master Guide ministry, e.g. `davaomission.mg@gmail.com`) and **one free GitHub account**. Setup takes about 20 minutes.

---

## Step 1 — Create the Google Sheet
1. Sign in to the Google account that will own the data.
2. Go to <https://sheets.new> and name the sheet **Master Guide Registry**.

## Step 2 — Add the backend code
1. In the sheet: **Extensions → Apps Script**.
2. Delete everything in `Code.gs`, then paste the whole contents of `apps-script/Code.gs`.
3. Press **Save** (💾).

## Step 3 — Run setup once
1. In the toolbar's function menu, choose **setup**, then press **Run**.
2. Google asks for permission → **Review permissions** → choose your account.
   If you see *"Google hasn't verified this app"*, click **Advanced → Go to (project name) (unsafe)** → **Allow**. This is normal for your own scripts.
3. Go back to the sheet. You will now see the tabs Members, Stages, Documents, Clusters, Users, Settings and Log.

> Don't edit the **Users** sheet by hand. Don't type into the other sheets while people are using the admin site. Reading or exporting them anytime is fine.

## Step 4 — Deploy the backend as a Web App
1. In Apps Script: **Deploy → New deployment**.
2. Click the ⚙️ next to "Select type" → **Web app**.
3. Set **Execute as:** *Me* and **Who has access:** *Anyone*. ("Anyone" is required so the public page can read the list. Editing still needs a login.)
4. Click **Deploy** and copy the **Web app URL** (it ends with `/exec`).

## Step 5 — Put the website on GitHub Pages
1. Create a free account at <https://github.com>.
2. Click **+ → New repository**. Name it, e.g. `davao-master-guides`, set it to **Public**, then **Create repository**.
3. Click **uploading an existing file** and drag in all the files from the `site` folder: `index.html`, `admin.html`, `style.css`, `config.js`. Click **Commit changes**.
4. Open `config.js` in GitHub → ✏️ edit → paste your Web App URL:
   ```js
   window.MG_CONFIG = {
     API_URL: 'https://script.google.com/macros/s/XXXXXXXX/exec'
   };
   ```
   **Commit changes**.
5. In the repository: **Settings → Pages**. Under "Build and deployment", set **Source:** *Deploy from a branch*, **Branch:** *main* / *(root)*, then **Save**.
6. After 1–2 minutes your site is live:
   - Public: `https://YOUR-GITHUB-NAME.github.io/davao-master-guides/`
   - Admin: `https://YOUR-GITHUB-NAME.github.io/davao-master-guides/admin.html`

## Step 6 — First sign-in (Director)
1. Open the Admin page and sign in with username **`director`** and password **`ChangeMe123`**.
2. You must choose a new password right away.
3. Then set things up in this order:
   - **Clusters**: rename *Cluster 1/2/3* to your real cluster names and add more.
   - **Stages & Documents**: adjust the stages (the **last stage = Invested**) and the required documents.
   - **Accounts**: create one account per Cluster Master Guide coordinator. Give each a username and a temporary password; they choose their own at first sign-in. Add their Gmail if they have one.
   - **Settings**: website title and subtitle, and whether to show the document count publicly.
   - **Import**: paste your existing list from Excel (see the format on that tab).

## Step 7 (optional) — Turn on "Sign in with Google"
Everyone can already sign in with username + password. To also allow the Google button:
1. Go to <https://console.cloud.google.com> (same Google account) → create a project, e.g. "Master Guide Registry".
2. **APIs & Services → OAuth consent screen**: choose **External**, enter an app name and your email, save. Then **publish the app** (click *Publish app* / set the publishing status to *In production*). No Google review is needed because it only asks for name and email.
3. **APIs & Services → Credentials → Create credentials → OAuth client ID**.
   - Application type: **Web application**
   - **Authorized JavaScript origins:** `https://YOUR-GITHUB-NAME.github.io`
   - Create, then copy the **Client ID** (ends with `.apps.googleusercontent.com`).
4. In the Admin site: **Settings → Google Client ID** → paste → **Save settings**.
5. In **Accounts**, make sure each person's Gmail is filled in. Only Gmail addresses saved on an account can sign in.

---

## Who can do what

| | Director | Cluster Coordinator | Public |
|---|---|---|---|
| View names, stage, progress, document count | ✅ all | ✅ own cluster | ✅ all |
| Add / edit / delete Master Guides | ✅ all clusters | ✅ own cluster only | ❌ |
| Tick documents, upload/view certificates | ✅ | ✅ own cluster | ❌ (never) |
| Import from Excel | ✅ | ✅ (own cluster) | ❌ |
| Edit stages, documents, clusters, settings | ✅ | ❌ | ❌ |
| Create/disable accounts, reset passwords | ✅ | ❌ | ❌ |
| Activity log | ✅ | ❌ | ❌ |

**How the progress bar works:** it fills by stage. With 5 stages, someone on stage 3 is at 60%. The last stage counts as **Invested** (100%, green).

---

## Everyday tips
- **Forgot password:** the Director opens **Accounts → the person → Reset password**.
- **Someone leaves:** untick "Account is active" instead of deleting, so the history stays.
- **Backup:** in the Google Sheet, use **File → Download → Excel** now and then. **Export CSV** in the admin site also works.
- **Public page update speed:** changes appear on the public page within about a minute (it's cached for speed).
- **Updating the backend code later:** paste the new `Code.gs`, then **Deploy → Manage deployments → ✏️ Edit → Version: New version → Deploy**. The URL stays the same.
- **Privacy:** only name, cluster, district, church, dates, stage and document count are public. Ask the Mission's permission before publishing the list, and remove anyone who asks not to be listed.

## Limits (all free)
- Google Sheets: millions of cells, so tens of thousands of Master Guides is fine.
- Google Drive: 15 GB free, enough for thousands of certificates at 5 MB max each (most scans are about 300 KB).
- GitHub Pages: free for public repositories with no expiry. The address is `name.github.io`. A custom domain such as `.org` is optional and costs about ₱600–900 a year.
