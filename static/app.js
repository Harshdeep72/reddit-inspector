/* ============================================================
   REDDIT INSPECTOR DASHBOARD - FRONTEND CONTROLLER
   ============================================================ */

document.addEventListener("DOMContentLoaded", () => {
    // DOM Elements
    const apiBaseInput = document.getElementById("api-base-url");
    const btnPing = document.getElementById("btn-ping");
    const apiStatusPill = document.getElementById("api-status");
    const redditUrlsTextarea = document.getElementById("reddit-urls");
    const urlCountBadge = document.getElementById("url-count-badge");
    const includeAuthorCheckbox = document.getElementById("include-author");
    const auditForm = document.getElementById("audit-form");
    const btnSubmit = document.getElementById("btn-submit");
    
    // States panels
    const stateWelcome = document.getElementById("state-welcome");
    const stateProgress = document.getElementById("state-progress");
    const resultsSummary = document.getElementById("results-summary");
    const resultsTableCard = document.getElementById("results-table-card");
    
    // Progress UI
    const jobIdDisplay = document.getElementById("job-id-display");
    const progressPercentage = document.getElementById("progress-percentage");
    const progressBarFill = document.getElementById("progress-bar-fill");
    const progressStatusText = document.getElementById("progress-status-text");
    const progressCounts = document.getElementById("progress-counts");
    
    // Summary Cards Stats
    const statLive = document.getElementById("stat-live");
    const statRemoved = document.getElementById("stat-removed");
    const statDeleted = document.getElementById("stat-deleted");
    const statError = document.getElementById("stat-error");
    
    // Table & Filters
    const resultsTbody = document.getElementById("results-tbody");
    const filterTabs = document.querySelectorAll(".filter-tab");
    const searchInput = document.getElementById("search-input");
    
    // Export Buttons
    const exportCsvBtn = document.getElementById("export-csv");
    const exportJsonBtn = document.getElementById("export-json");
    const exportExcelBtn = document.getElementById("export-excel");
    
    // Global job details cache
    let currentJobId = null;
    let pollInterval = null;
    let jobResults = [];
    let activeFilter = "all";

    // Auto-detect and populate API base URL
    function detectApiBase() {
        const host = window.location.host;
        const protocol = window.location.protocol;
        
        // If loaded inside Hugging Face Spaces iframe or domain
        if (host.includes("hf.space")) {
            // e.g. user-space-name.hf.space -> backend is same domain
            apiBaseInput.value = `${protocol}//${host}`;
        } else {
            // Default to permanent production Hugging Face API Space
            apiBaseInput.value = "https://harrry953489-reddit-inspector-api.hf.space";
        }
    }
    detectApiBase();

    // Verify backend connectivity
    async function checkBackendHealth() {
        const baseUrl = apiBaseInput.value.replace(/\/$/, "");
        
        // Visual indicator pinging state
        apiStatusPill.className = "api-status-pill";
        apiStatusPill.querySelector(".status-indicator").className = "status-indicator warning";
        apiStatusPill.querySelector(".status-label").textContent = "Pinging API...";
        
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 6000);
            
            const response = await fetch(`${baseUrl}/health`, { 
                method: "GET",
                signal: controller.signal
            });
            clearTimeout(timeoutId);
            
            if (response.ok) {
                apiStatusPill.querySelector(".status-indicator").className = "status-indicator success";
                apiStatusPill.querySelector(".status-label").textContent = "API Connected";
                return true;
            } else {
                throw new Error("HTTP Status Error");
            }
        } catch (e) {
            apiStatusPill.querySelector(".status-indicator").className = "status-indicator danger";
            apiStatusPill.querySelector(".status-label").textContent = "API Offline";
            return false;
        }
    }
    
    // Trigger check on startup
    checkBackendHealth();
    
    // Event listeners
    btnPing.addEventListener("click", checkBackendHealth);
    apiBaseInput.addEventListener("blur", checkBackendHealth);
    
    // Update URL Counter Badge
    redditUrlsTextarea.addEventListener("input", () => {
        const urls = getParsedUrls();
        urlCountBadge.textContent = `${urls.length} / 500`;
        if (urls.length > 500) {
            urlCountBadge.style.color = "var(--error)";
            btnSubmit.disabled = true;
        } else {
            urlCountBadge.style.color = "";
            btnSubmit.disabled = false;
        }
    });

    function getParsedUrls() {
        const rawText = redditUrlsTextarea.value || "";
        return rawText
            .split("\n")
            .map(line => line.trim())
            .filter(line => line.length > 0 && (line.startsWith("http://") || line.startsWith("https://")));
    }

    // Submit Job Form
    auditForm.addEventListener("submit", async (e) => {
        e.preventDefault();
        
        const urls = getParsedUrls();
        if (urls.length === 0) {
            alert("Please paste at least one valid Reddit URL starting with http:// or https://");
            return;
        }
        if (urls.length > 500) {
            alert("Maximum limit is 500 URLs per job batch.");
            return;
        }

        // Ping check first
        const isOnline = await checkBackendHealth();
        if (!isOnline) {
            const proceed = confirm("The API base URL appears to be offline. Try submitting anyway?");
            if (!proceed) return;
        }

        // Reset UI state for new job
        currentJobId = null;
        jobResults = [];
        if (pollInterval) clearInterval(pollInterval);
        
        // Update dashboard panels
        stateWelcome.classList.add("hidden");
        resultsSummary.classList.add("hidden");
        resultsTableCard.classList.add("hidden");
        stateProgress.classList.remove("hidden");
        
        // Progress defaults
        progressBarFill.style.width = "0%";
        progressPercentage.textContent = "0%";
        jobIdDisplay.textContent = "Job ID: Queueing...";
        progressStatusText.textContent = "Sending batch payload to API...";
        progressCounts.textContent = `0 / ${urls.length} Completed`;

        // Disable submit button & textarea during process
        btnSubmit.disabled = true;
        redditUrlsTextarea.disabled = true;
        includeAuthorCheckbox.disabled = true;
        btnSubmit.querySelector("span").textContent = "Auditing Job Running...";

        const apiBase = apiBaseInput.value.replace(/\/$/, "");
        const payload = {
            urls: urls,
            include_author: includeAuthorCheckbox.checked
        };

        try {
            const response = await fetch(`${apiBase}/api/bulk/check`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                const errorData = await response.json();
                throw new Error(errorData.error || "Internal Server Error");
            }

            const data = await response.json();
            currentJobId = data.job_id;
            
            jobIdDisplay.textContent = `Job ID: ${currentJobId}`;
            progressStatusText.textContent = "Job accepted. Running stealth scraper worker tasks...";
            
            // Start polling status
            startPolling(currentJobId);

        } catch (err) {
            // Return to welcome / error state
            alert(`Error submitting job: ${err.message}`);
            stateProgress.classList.add("hidden");
            stateWelcome.classList.remove("hidden");
            resetFormControls();
        }
    });

    function resetFormControls() {
        btnSubmit.disabled = false;
        redditUrlsTextarea.disabled = false;
        includeAuthorCheckbox.disabled = false;
        btnSubmit.querySelector("span").textContent = "Analyze URLs";
    }

    // Polling Status check
    function startPolling(jobId) {
        const apiBase = apiBaseInput.value.replace(/\/$/, "");
        
        pollInterval = setInterval(async () => {
            try {
                const res = await fetch(`${apiBase}/api/bulk/status/${jobId}`);
                if (!res.ok) throw new Error("Status Fetch Error");
                
                const job = await res.json();
                const total = job.total;
                const progress = job.progress;
                const percentage = total > 0 ? Math.round((progress / total) * 100) : 0;
                
                // Update Progress UI
                progressBarFill.style.width = `${percentage}%`;
                progressPercentage.textContent = `${percentage}%`;
                progressCounts.textContent = `${progress} / ${total} Completed`;
                
                if (job.status === "running" || job.status === "accepted") {
                    progressStatusText.textContent = `Scraping content: ${progress} checked. Pausing between batches to stay stealth...`;
                    if (job.results && job.results.length > 0) {
                        jobResults = job.results;
                        renderDashboard(jobResults);
                    }
                } else if (job.status === "done") {
                    clearInterval(pollInterval);
                    progressStatusText.textContent = "Job completed! Finalizing results table...";
                    jobResults = job.results;
                    
                    setTimeout(() => {
                        // Render results dashboard and hide progress card
                        stateProgress.classList.add("hidden");
                        renderDashboard(jobResults);
                        resetFormControls();
                    }, 500);
                }
            } catch (err) {
                console.error("[POLLER] Error during job check:", err);
            }
        }, 2000);
    }

    // Render stats & table grid
    function renderDashboard(results) {
        // Calculate status metrics
        let liveCount = 0;
        let removedCount = 0;
        let deletedCount = 0;
        let errorCount = 0;
        
        results.forEach(r => {
            const status = (r.status || "").toLowerCase();
            if (status === "live") liveCount++;
            else if (status === "removed" || status === "spam") removedCount++;
            else if (status === "deleted" || status === "not_found") deletedCount++;
            else if (status === "error") errorCount++;
        });

        // Set metrics text
        statLive.textContent = liveCount;
        statRemoved.textContent = removedCount;
        statDeleted.textContent = deletedCount;
        statError.textContent = errorCount;

        // Set Toolbar Counters
        document.getElementById("count-all").textContent = `(${results.length})`;
        document.getElementById("count-live").textContent = `(${liveCount})`;
        document.getElementById("count-removed").textContent = `(${removedCount})`;
        document.getElementById("count-deleted").textContent = `(${deletedCount})`;
        document.getElementById("count-error").textContent = `(${errorCount})`;

        // Show Summary & Results table
        resultsSummary.classList.remove("hidden");
        resultsTableCard.classList.remove("hidden");

        // Populate table
        populateTable(results);
    }

    function getStatusBadgeClass(status) {
        status = status.toLowerCase();
        if (status === "live") return "status-badge live";
        if (status === "removed" || status === "spam") return "status-badge removed";
        if (status === "deleted") return "status-badge deleted";
        return "status-badge error";
    }

    function populateTable(results) {
        resultsTbody.innerHTML = "";
        
        // Apply active filter and search keyword
        const searchKeyword = searchInput.value.toLowerCase().trim();
        
        const filteredResults = results.filter(r => {
            // Apply Status Filter
            if (activeFilter !== "all") {
                const status = r.status.toLowerCase();
                if (activeFilter === "live" && status !== "live") return false;
                if (activeFilter === "removed" && status !== "removed" && status !== "spam") return false;
                if (activeFilter === "deleted" && status !== "deleted" && status !== "not_found") return false;
                if (activeFilter === "error" && status !== "error") return false;
            }

            // Apply Search filter
            if (searchKeyword) {
                const title = (r.data?.title || "").toLowerCase();
                const preview = (r.data?.body_preview || "").toLowerCase();
                const author = (r.data?.author || "").toLowerCase();
                const url = r.url.toLowerCase();
                
                return title.includes(searchKeyword) || 
                       preview.includes(searchKeyword) || 
                       author.includes(searchKeyword) || 
                       url.includes(searchKeyword);
            }
            
            return true;
        });

        if (filteredResults.length === 0) {
            resultsTbody.innerHTML = `
                <tr>
                    <td colspan="5" class="empty-table-state" style="text-align: center; color: var(--text-muted); padding: 3rem 1.5rem;">
                        No matching audit entries found.
                    </td>
                </tr>
            `;
            return;
        }

        filteredResults.forEach((r, index) => {
            const tr = document.createElement("tr");
            
            // Col 1: Index
            const indexHtml = `<span style="color: var(--text-muted); font-weight: 500;">${index + 1}</span>`;
            
            // Col 2: URL
            const urlHtml = `
                <div class="url-cell" style="max-width: 450px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                    <a href="${escapeHtml(r.url)}" target="_blank" class="detail-url" title="${escapeHtml(r.url)}" style="font-weight: 500; font-size: 0.85rem;">
                        ${escapeHtml(r.url)}
                    </a>
                </div>
            `;
            
            // Col 3: Type Badge
            const typeLower = (r.type || "post").toLowerCase();
            const typeBadgeHtml = `<span class="content-type-badge ${typeLower}">${typeLower}</span>`;
            
            // Col 4: Status Badge
            const statusUpper = (r.status || "UNKNOWN").toUpperCase();
            const badgeClass = getStatusBadgeClass(r.status);
            const statusHtml = `<span class="${badgeClass}">${statusUpper}</span>`;

            // Col 5 & 6: Author and Author Status
            let authorNameHtml = `<span style="color: var(--text-muted); font-style: italic;">Unknown</span>`;
            let authorStatusHtml = `<span class="author-status unknown">UNKNOWN</span>`;
            
            if (r.author) {
                authorNameHtml = `<span class="author-name" style="font-weight: 600;">u/${escapeHtml(r.author.username)}</span>`;
                const authStatus = (r.author.status || "unknown").toLowerCase();
                let statusBadgeText = authStatus.toUpperCase();
                let karmaText = "";
                
                if (authStatus === "active") {
                    const karmaVal = r.author.total_karma || 0;
                    karmaText = ` <span style="font-size: 0.65rem; color: var(--text-muted); font-weight: normal;">(${formatKarma(karmaVal)} karma)</span>`;
                }
                
                authorNameHtml += karmaText;
                authorStatusHtml = `<span class="author-status ${authStatus}">${statusBadgeText}</span>`;
            } else if (r.data?.author) {
                const authorRaw = r.data.author;
                if (authorRaw === "[deleted]") {
                    authorNameHtml = `<span class="author-name" style="color: var(--text-muted);">[deleted]</span>`;
                    authorStatusHtml = `<span class="author-status deleted">DELETED</span>`;
                } else {
                    authorNameHtml = `<span class="author-name" style="font-weight: 600;">u/${escapeHtml(authorRaw)}</span>`;
                    if (pollInterval && includeAuthorCheckbox.checked) {
                        authorStatusHtml = `<span class="author-status unknown">PENDING</span>`;
                    } else {
                        authorStatusHtml = `<span class="author-status unknown">UNKNOWN</span>`;
                    }
                }
            }

            // Append row cells
            tr.innerHTML = `
                <td>${indexHtml}</td>
                <td>${urlHtml}</td>
                <td>${typeBadgeHtml}</td>
                <td>${statusHtml}</td>
                <td>${authorNameHtml}</td>
                <td>${authorStatusHtml}</td>
            `;
            resultsTbody.appendChild(tr);
        });
    }

    // Filter Tab Click handlers
    filterTabs.forEach(tab => {
        tab.addEventListener("click", () => {
            filterTabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            activeFilter = tab.getAttribute("data-filter");
            populateTable(jobResults);
        });
    });

    // Realtime Search Input listener
    searchInput.addEventListener("input", () => {
        populateTable(jobResults);
    });

    // HTML escape utility
    function escapeHtml(str) {
        if (!str) return "";
        return str
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;")
            .replace(/"/g, "&quot;")
            .replace(/'/g, "&#039;");
    }

    function formatKarma(num) {
        if (num >= 1000000) {
            return (num / 1000000).toFixed(1) + "M";
        }
        if (num >= 1000) {
            return (num / 1000).toFixed(1) + "k";
        }
        return num;
    }

    // EXPORT HANDLERS
    exportCsvBtn.addEventListener("click", () => {
        if (jobResults.length === 0) return;
        
        let csvContent = "data:text/csv;charset=utf-8,";
        csvContent += "Type,URL,Status,Author,Author Status,Subreddit,Title/Body Preview,Score\n";
        
        jobResults.forEach(r => {
            const type = r.type || "unknown";
            const url = r.url;
            const status = r.status || "error";
            const author = r.author?.username || r.data?.author || "unknown";
            const authorStatus = r.author?.status || "unknown";
            const sub = r.data?.subreddit || "unknown";
            const detailText = r.data?.title || r.data?.body_preview || "";
            const score = r.data?.score || 0;
            
            // Clean fields to prevent breaking CSV formatting
            const cleanDetail = detailText.replace(/"/g, '""').replace(/\n/g, ' ');
            
            csvContent += `"${type}","${url}","${status}","${author}","${authorStatus}","${sub}","${cleanDetail}",${score}\n`;
        });
        
        const encodedUri = encodeURI(csvContent);
        const link = document.createElement("a");
        link.setAttribute("href", encodedUri);
        link.setAttribute("download", `reddit_audit_${currentJobId || "export"}.csv`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    exportJsonBtn.addEventListener("click", () => {
        if (jobResults.length === 0) return;
        
        const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(jobResults, null, 2));
        const link = document.createElement("a");
        link.setAttribute("href", dataStr);
        link.setAttribute("download", `reddit_audit_${currentJobId || "export"}.json`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });

    exportExcelBtn.addEventListener("click", () => {
        if (jobResults.length === 0) return;
        
        let tabText = `
            <html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel" xmlns="http://www.w3.org/TR/REC-html40">
            <head>
                <!--[if gte mso 9]>
                <xml>
                    <x:ExcelWorkbook>
                        <x:ExcelWorksheets>
                            <x:ExcelWorksheet>
                                <x:Name>Reddit Audit</x:Name>
                                <x:WorksheetOptions>
                                    <x:DisplayGridlines/>
                                </x:WorksheetOptions>
                            </x:ExcelWorksheet>
                        </x:ExcelWorksheets>
                    </x:ExcelWorkbook>
                </xml>
                <![endif]-->
                <meta charset="utf-8">
                <style>
                    th { background-color: #8b5cf6; color: white; font-weight: bold; }
                    td, th { border: 0.5pt solid #ccc; padding: 6px 10px; font-family: Arial, sans-serif; font-size: 10pt; }
                </style>
            </head>
            <body>
                <table>
                    <thead>
                        <tr>
                            <th>Content Type</th>
                            <th>URL</th>
                            <th>Status</th>
                            <th>Author</th>
                            <th>Author Status</th>
                            <th>Subreddit</th>
                            <th>Score</th>
                            <th>Title/Body Preview</th>
                        </tr>
                    </thead>
                    <tbody>
        `;
        
        jobResults.forEach(r => {
            const type = r.type || "unknown";
            const url = r.url;
            const status = r.status || "error";
            const author = r.author?.username || r.data?.author || "unknown";
            const authorStatus = r.author?.status || "unknown";
            const sub = r.data?.subreddit || "unknown";
            const detailText = r.data?.title || r.data?.body_preview || "";
            const score = r.data?.score || 0;
            
            tabText += `
                <tr>
                    <td>${escapeHtml(type.toUpperCase())}</td>
                    <td>${escapeHtml(url)}</td>
                    <td>${escapeHtml(status.toUpperCase())}</td>
                    <td>u/${escapeHtml(author)}</td>
                    <td>${escapeHtml(authorStatus.toUpperCase())}</td>
                    <td>r/${escapeHtml(sub)}</td>
                    <td>${score}</td>
                    <td>${escapeHtml(detailText)}</td>
                </tr>
            `;
        });
        
        tabText += `
                    </tbody>
                </table>
            </body>
            </html>
        `;
        
        const blob = new Blob([tabText], { type: "application/vnd.ms-excel;charset=utf-8;" });
        const link = document.createElement("a");
        link.href = URL.createObjectURL(blob);
        link.setAttribute("download", `reddit_audit_${currentJobId || "export"}.xls`);
        document.body.appendChild(link);
        link.click();
        document.body.removeChild(link);
    });
});
