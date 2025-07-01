const express = require('express');
const { Octokit } = require('@octokit/rest');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public')); // Serve static files (index.html)

const OWNER = 'teebase-net';
const REPO = 'grist-core';
const BRANCH = 'custom-ui';
const UPSTREAM_OWNER = 'gristlabs';
const UPSTREAM_REPO = 'grist-core';
const FILE_PATH = 'custom-files.json';

// In-memory token storage (ephemeral, per session)
let githubToken = null;

// Middleware to check token
const requireToken = (req, res, next) => {
  if (!githubToken) {
    return res.status(401).json({ error: 'GitHub token required' });
  }
  next();
};

// Initialize Octokit with token
const getOctokit = () => new Octokit({ auth: githubToken });

// Set token
app.post('/api/set-token', (req, res) => {
  const { token } = req.body;
  if (!token) {
    return res.status(400).json({ error: 'Token is required' });
  }
  githubToken = token;
  res.json({ message: 'Token set' });
});

// Load custom-files.json
app.get('/api/files', requireToken, async (req, res) => {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path: FILE_PATH,
      ref: BRANCH,
    });
    const files = JSON.parse(Buffer.from(data.content, 'base64').toString());
    res.json({ files });
  } catch (error) {
    if (error.status === 404) {
      await saveFiles([]); // Create empty file
      res.json({ files: [] });
    } else {
      res.status(error.status || 500).json({ error: error.message });
    }
  }
});

// Save custom-files.json
async function saveFiles(files, message = `Update ${FILE_PATH}`) {
  const octokit = getOctokit();
  let sha = null;
  try {
    const { data } = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path: FILE_PATH,
      ref: BRANCH,
    });
    sha = data.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  await octokit.repos.createOrUpdateFileContents({
    owner: OWNER,
    repo: REPO,
    path: FILE_PATH,
    message,
    content: Buffer.from(JSON.stringify(files, null, 2)).toString('base64'),
    branch: BRANCH,
    sha,
  });
}

app.post('/api/files', requireToken, async (req, res) => {
  const { files } = req.body;
  try {
    await saveFiles(files);
    res.json({ message: 'Files saved' });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Auto-detect files
app.get('/api/detect-files', requireToken, async (req, res) => {
  try {
    const octokit = getOctokit();
    const { data } = await octokit.repos.compareCommits({
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
      base: 'main',
      head: `${OWNER}:${BRANCH}`,
    });
    const files = data.files
      .map(f => f.filename)
      .filter(f => !/\.(md|txt|doc|json)$/.test(f));
    res.json({ files });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Check upstream changes and non-customized files
app.get('/api/check-upstream', requireToken, async (req, res) => {
  try {
    const octokit = getOctokit();
    // Get latest upstream tag and custom files
    const { data: tags } = await octokit.repos.listTags({
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
    });
    if (!tags.length) throw new Error('No upstream tags found');
    const latestTag = tags[0].name;
    const { data: customFileData } = await octokit.repos.getContent({
      owner: OWNER,
      repo: REPO,
      path: FILE_PATH,
      ref: BRANCH,
    });
    const customFiles = JSON.parse(Buffer.from(customFileData.content, 'base64').toString());
    // Compare branches for non-customized files
    const { data: compareData } = await octokit.repos.compareCommits({
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
      base: 'main',
      head: `${OWNER ROUNDtrip:${BRANCH}`,
    });
    const nonCustomFiles = compareData.files
      .map(f => f.filename)
      .filter(f => !customFiles.includes(f) && !/\.(md|txt|doc|json)$/.test(f));
    // Check each custom file
    const results = [];
    for (const file of customFiles) {
      const { data: compare } = await octokit.repos.compareCommits({
        owner: UPSTREAM_OWNER,
        repo: UPSTREAM_REPO,
        base: latestTag,
        head: `${OWNER}:${BRANCH}`,
      });
      const hasContentChanges = compare.files.some(f => f.filename === file);
      let customDate = null;
      let upstreamDate = null;
      const { data: customCommits } = await octokit.repos.listCommits({
        owner: OWNER,
        repo: REPO,
        path: file,
        sha: BRANCH,
        per_page: 1,
      });
      if (customCommits.length) {
        customDate = new Date(customCommits[0].commit.author.date);
      }
      const { data: upstreamCommits } = await octokit.repos.listCommits({
        owner: UPSTREAM_OWNER,
        repo: UPSTREAM_REPO,
        path: file,
        sha: latestTag,
        per_page: 1,
      });
      if (upstreamCommits.length) {
        upstreamDate = new Date(upstreamCommits[0].commit.author.date);
      }
      const customDays = customDate ? Math.floor((new Date() - customDate) / (1000 * 60 * 60 * 24)) : 0;
      const upstreamDays = upstreamDate ? Math.floor((new Date() - upstreamDate) / (1000 * 60 * 60 * 24)) : Infinity;
      results.push({ file, customDays, upstreamDays, hasContentChanges });
    }
    // Get rate limit
    const { data: rateLimit } = await octokit.rateLimit.get();
    res.json({
      latestTag,
      results,
      nonCustomFiles,
      rateLimit: `${rateLimit.rate.remaining}/${rateLimit.rate.limit}`,
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message });
  }
});

// Update non-customized file
app.post('/api/update-file', requireToken, async (req, res) => {
  const { file } = req.body;
  try {
    const octokit = getOctokit();
    // Get upstream file content
    const { data: upstreamContent } = await octokit.repos.getContent({
      owner: UPSTREAM_OWNER,
      repo: UPSTREAM_REPO,
      path: file,
      ref: 'main',
    });
    const content = Buffer.from(upstreamContent.content, 'base64').toString();
    // Get current file SHA in custom-ui (if exists)
    let sha = null;
    try {
      const { data } = await octokit.repos.getContent({
        owner: OWNER,
        repo: REPO,
        path: file,
        ref: BRANCH,
      });
      sha = data.sha;
    } catch (error) {
      if (error.status !== 404) throw error;
    }
    // Update file in custom-ui
    await octokit.repos.createOrUpdateFileContents({
      owner: OWNER,
      repo: REPO,
      path: file,
      message: `Update ${file} from upstream main`,
      content: Buffer.from(content).toString('base64'),
      branch: BRANCH,
      sha,
    });
    res.json({ message: `Updated ${file}` });
  } catch (error) {
    res.status(error.status || 500).json({ error: `Failed to update ${file}: ${error.message}` });
  }
});

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});
