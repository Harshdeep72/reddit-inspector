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
            // Default to local Uvicorn port
            apiBaseInput.value = "http://127.0.0.1:7860";
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
                
                if (job.status === "running") {
                    progressStatusText.textContent = `Scraping content: ${progress} checked. Pausing between batches to stay stealth...`;
                } else if (job.status === "done") {
                    clearInterval(pollInterval);
                    progressStatusText.textContent = "Job completed! Processing results table...";
                    jobResults = job.results;
                    
                    setTimeout(() => {
                        // Render results dashboard
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

        filteredResults.forEach(r => {
            const tr = document.createElement("tr");
            
            // Col 1: Type Badge
            const typeLower = (r.type || "post").toLowerCase();
            const typeBadgeHtml = `<span class="content-type-badge ${typeLower}">${typeLower}</span>`;
            
            // Col 2: URL & Title Details
            let detailsHtml = "";
            if (typeLower === "post") {
                const title = r.data?.title || "Reddit Post";
                detailsHtml = `
                    <div class="detail-cell">
                        <span class="detail-title">${escapeHtml(title)}</span>
                        <a href="${escapeHtml(r.url)}" target="_blank" class="detail-url">
                            <span>Open in Reddit</span>
                            <svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                        </a>
                    </div>
                `;
            } else {
                const preview = r.data?.body_preview || "";
                detailsHtml = `
                    <div class="detail-cell">
                        <span class="detail-preview">"${escapeHtml(preview)}..."</span>
                        <a href="${escapeHtml(r.url)}" target="_blank" class="detail-url">
                            <span>Open Comment Thread</span>
                            <svg viewBox="0 0 24 24" width="10" height="10" stroke="currentColor" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>
                        </a>
                    </div>
                `;
            }

            // Col 3: Status Badge
            const statusUpper = (r.status || "UNKNOWN").toUpperCase();
            const badgeClass = getStatusBadgeClass(r.status);
            const statusHtml = `<span class="${badgeClass}">${statusUpper}</span>`;

            // Col 4: Author check details
            let authorHtml = `<span style="color: var(--text-muted); font-style: italic;">Unknown</span>`;
            if (r.author) {
                const authStatus = (r.author.status || "unknown").toLowerCase();
                let statusBadgeText = authStatus.toUpperCase();
                let karmaText = "";
                
                if (authStatus === "active") {
                    const karmaVal = r.author.total_karma || 0;
                    karmaText = `<span style="font-size: 0.65rem; color: var(--text-muted);">${formatKarma(karmaVal)} karma</span>`;
                }

                authorHtml = `
                    <div class="author-info">
                        <div class="author-details">
                            <span class="author-name">u/${escapeHtml(r.author.username)}</span>
                            <span class="author-status ${authStatus}">${statusBadgeText}</span>
                            ${karmaText}
                        </div>
                    </div>
                `;
            } else if (r.data?.author) {
                // Verified deleted author
                const authorRaw = r.data.author;
                if (authorRaw === "[deleted]") {
                    authorHtml = `
                        <div class="author-info">
                            <div class="author-details">
                                <span class="author-name">[deleted]</span>
                                <span class="author-status deleted">DELETED</span>
                            </div>
                        </div>
                    `;
                } else {
                    authorHtml = `<span class="author-name">u/${escapeHtml(authorRaw)}</span>`;
                }
            }

            // Col 5: Subreddit
            const sub = r.data?.subreddit ? `r/${escapeHtml(r.data.subreddit)}` : "unknown";
            const subredditHtml = `<span style="font-weight: 500;">${sub}</span>`;

            // Append row
            tr.innerHTML = `
                <td>${typeBadgeHtml}</td>
                <td>${detailsHtml}</td>
                <td>${statusHtml}</td>
                <td>${authorHtml}</td>
                <td>${subredditHtml}</td>
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
});
