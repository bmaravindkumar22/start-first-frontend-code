// Resume Parser: reads a PDF or DOCX in the browser, compares it with a job
// description, and renders a scorecard. Everything runs locally.

(() => {
    const MAX_BYTES = 5 * 1024 * 1024;
    const MIN_JD_CHARS = 30;
    const MIN_RESUME_CHARS = 50;

    // Known skills and tools. A term found in the job description counts for
    // more in the score than a generic word does.
    const SKILLS = [
        "javascript", "typescript", "python", "java", "c++", "c#", "go", "rust", "php", "ruby",
        "sql", "html", "css", "react", "vue", "angular", "next.js", "node.js", "express", "django",
        "flask", "spring", "rest", "rest api", "graphql", "api", "docker", "kubernetes", "aws", "azure",
        "gcp", "git", "ci/cd", "linux", "mongodb", "postgresql", "mysql", "redis", "tailwind", "testing",
        "jest", "agile", "scrum", "machine learning", "data analysis", "excel", "figma", "microservices",
        "terraform", "communication", "leadership", "problem solving", "teamwork",
    ];

    const STOPWORDS = new Set(
        `a an and are as at be been being by can could do does for from has have had in into is it
     its of on or our out over that the their them there these this those to was we were what when
     which who will with would you your job role work working team teams experience experienced years
     year ability strong good great excellent plus including include includes using use new join
     looking about across within other etc responsibilities requirements required preferred nice
     knowledge understanding ideal candidate must should may also such any all each more most
     related make help build team we're you're`.split(/\s+/)
    );

    // Strings that show a resume section exists.
    const SECTION_CHECKS = [
        { name: "Experience", test: (t) => /\b(experience|work history|employment)\b/.test(t) },
        { name: "Education", test: (t) => /\b(education|university|college|bachelor|master|degree)\b/.test(t) },
        { name: "Skills", test: (t) => /\b(skills?|technologies|tech stack)\b/.test(t) },
        { name: "Projects", test: (t) => /\bprojects?\b/.test(t) },
        { name: "Contact details", test: (t) => /[\w.+-]+@[\w-]+\.[\w.]+/.test(t) || /\+?\d[\d\s-]{8,}\d/.test(t) },
    ];

    // Numbers that show measurable results, such as "40%", "$2M", "3x", "10k users".
    const METRIC_PATTERN =
        /\d+(\.\d+)?\s?%|\$\s?\d[\d,.]*|\b\d+(\.\d+)?\s?(x|k|m|million|billion|users|customers|requests|ms|seconds|hours)\b/gi;

    // ---------- DOM references ----------
    const $ = (id) => document.getElementById(id);
    const dropzone = $("dropzone");
    const fileInput = $("file-input");
    const fileNameEl = $("file-name");
    const jdInput = $("jd");
    const analyzeBtn = $("analyze-btn");
    const errorEl = $("error");
    const results = $("results");

    let selectedFile = null;

    // ---------- File handling ----------
    function showError(message) {
        errorEl.textContent = message;
        errorEl.classList.remove("hidden");
    }

    function clearError() {
        errorEl.textContent = "";
        errorEl.classList.add("hidden");
    }

    function setFile(file) {
        clearError();
        const name = file.name.toLowerCase();

        if (!name.endsWith(".pdf") && !name.endsWith(".docx")) {
            if (name.endsWith(".doc")) {
                showError("Old .doc files are not supported. Open it in Word and save it as .docx.");
            } else {
                showError("Please upload a PDF or DOCX file.");
            }
            return;
        }
        if (file.size > MAX_BYTES) {
            showError("That file is larger than 5 MB.");
            return;
        }

        selectedFile = file;
        fileNameEl.textContent = file.name;
        fileNameEl.classList.remove("hidden");
    }

    // Drag and drop. Browsers open a dropped file by default, so we stop the
    // default for the whole window and only accept drops on the dropzone.
    ["dragenter", "dragover"].forEach((type) =>
        dropzone.addEventListener(type, (event) => {
            event.preventDefault();
            dropzone.classList.add("is-dragover");
        })
    );

    ["dragleave", "drop"].forEach((type) =>
        dropzone.addEventListener(type, () => dropzone.classList.remove("is-dragover"))
    );

    dropzone.addEventListener("drop", (event) => {
        event.preventDefault();
        const file = event.dataTransfer.files[0];
        if (file) setFile(file);
    });

    window.addEventListener("dragover", (event) => event.preventDefault());
    window.addEventListener("drop", (event) => event.preventDefault());

    fileInput.addEventListener("change", () => {
        if (fileInput.files[0]) setFile(fileInput.files[0]);
    });

    // Keyboard users can press Enter or Space on the label to open the picker.
    dropzone.setAttribute("tabindex", "0");
    dropzone.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            fileInput.click();
        }
    });

    // ---------- Text extraction ----------
    async function extractText(file) {
        if (typeof pdfjsLib === "undefined" || typeof mammoth === "undefined") {
            throw new Error("The file readers did not load. Check your internet connection and reload.");
        }

        const buffer = await file.arrayBuffer();
        const name = file.name.toLowerCase();

        if (name.endsWith(".pdf")) {
            pdfjsLib.GlobalWorkerOptions.workerSrc =
                "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
            const pdf = await pdfjsLib.getDocument({ data: buffer }).promise;
            let text = "";
            for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber++) {
                const page = await pdf.getPage(pageNumber);
                const content = await page.getTextContent();
                text += content.items.map((item) => item.str).join(" ") + "\n";
            }
            return text;
        }

        const result = await mammoth.extractRawText({ arrayBuffer: buffer });
        return result.value;
    }

    // ---------- Analysis ----------
    // Lowercase and collapse whitespace so matching is consistent.
    function normalize(text) {
        return text.toLowerCase().replace(/\s+/g, " ");
    }

    // True when `term` appears as a whole word or phrase. The lookarounds stop
    // "go" from matching inside "good" and "java" from matching "javascript".
    function hasTerm(haystack, term) {
        const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        return new RegExp(`(^|[^a-z0-9+#])${escaped}($|[^a-z0-9+#])`).test(haystack);
    }

    // Break the job description into words, dropping trailing punctuation.
    function tokenize(text) {
        return (normalize(text).match(/[a-z0-9][a-z0-9+#./-]*/g) || []).map((t) =>
            t.replace(/[./-]+$/, "")
        );
    }

    // Build the list of terms to check: known skills found in the job
    // description (weight 3), plus frequent words and two-word phrases (weight 1).
    function extractKeywords(jdText) {
        const jdLower = normalize(jdText);
        const skillsInJd = SKILLS.filter((skill) => hasTerm(jdLower, skill));

        const words = tokenize(jdText);
        const counts = new Map();
        words.forEach((word, i) => {
            if (word.length < 2 || STOPWORDS.has(word) || /^\d+$/.test(word)) return;
            counts.set(word, (counts.get(word) || 0) + 1);

            const next = words[i + 1];
            if (next && next.length >= 2 && !STOPWORDS.has(next) && !/^\d+$/.test(next)) {
                const phrase = `${word} ${next}`;
                counts.set(phrase, (counts.get(phrase) || 0) + 1);
            }
        });

        const weights = new Map();
        skillsInJd.forEach((skill) => weights.set(skill, 3));

        [...counts.entries()]
            .filter(([term, count]) => count >= 2 && !weights.has(term))
            .sort((a, b) => b[1] - a[1])
            .slice(0, 15)
            .forEach(([term]) => weights.set(term, 1));

        return { skillsInJd, weights };
    }

    function analyze(resumeText, jdText) {
        const resumeLower = normalize(resumeText);
        const { skillsInJd, weights } = extractKeywords(jdText);

        // Keyword coverage, weighted.
        let totalWeight = 0;
        let matchedWeight = 0;
        const matched = [];
        const missing = [];
        weights.forEach((weight, term) => {
            totalWeight += weight;
            if (hasTerm(resumeLower, term)) {
                matchedWeight += weight;
                matched.push({ term, weight });
            } else {
                missing.push({ term, weight });
            }
        });
        const keywordScore = totalWeight ? (matchedWeight / totalWeight) * 100 : 0;

        // Coverage of the known skills the job asks for.
        const skillsMatched = skillsInJd.filter((skill) => hasTerm(resumeLower, skill));
        const skillsScore = skillsInJd.length
            ? (skillsMatched.length / skillsInJd.length) * 100
            : keywordScore;

        // Expected sections: each one present is worth 20 points.
        const sectionResults = SECTION_CHECKS.map((check) => ({
            name: check.name,
            found: check.test(resumeLower),
        }));
        const sectionsScore =
            (sectionResults.filter((s) => s.found).length / sectionResults.length) * 100;

        // Measurable results. Five or more numbers counts as full marks.
        const metricCount = (resumeText.match(METRIC_PATTERN) || []).length;
        const impactScore = Math.min(metricCount / 5, 1) * 100;

        const wordCount = resumeText.trim().split(/\s+/).filter(Boolean).length;

        const overall = Math.round(
            0.45 * keywordScore + 0.25 * skillsScore + 0.15 * sectionsScore + 0.15 * impactScore
        );

        // Strengths and weaknesses, written as plain sentences.
        const strengths = [];
        const weaknesses = [];

        if (skillsMatched.length) {
            strengths.push(`You match ${skillsMatched.length} of the ${skillsInJd.length} skills the job asks for.`);
        }
        const presentSections = sectionResults.filter((s) => s.found).map((s) => s.name);
        if (presentSections.length) {
            strengths.push(`Your resume has these sections: ${presentSections.join(", ")}.`);
        }
        if (metricCount >= 3) {
            strengths.push(`You quantify your results (${metricCount} measurable figures). Recruiters look for this.`);
        }
        if (wordCount >= 250 && wordCount <= 1000) {
            strengths.push("The length is in a good range for a resume.");
        }

        const missingSkills = skillsInJd.filter((skill) => !skillsMatched.includes(skill));
        if (missingSkills.length) {
            weaknesses.push(
                `The job asks for ${missingSkills.join(", ")}, which your resume does not mention. Add them only where you have real experience.`
            );
        }
        sectionResults
            .filter((s) => !s.found)
            .forEach((s) => weaknesses.push(`No "${s.name}" section was found. Add one with a clear heading.`));
        if (metricCount < 3) {
            weaknesses.push("Few measurable results were found. Add numbers such as percentages, users served or time saved.");
        }
        if (wordCount < 250) {
            weaknesses.push("The resume is short. Add more detail on your projects and responsibilities.");
        }
        if (wordCount > 1000) {
            weaknesses.push("The resume is long. Trim it to one or two pages, focusing on the most relevant experience.");
        }

        return {
            overall,
            breakdown: [
                { label: "Keyword match", score: keywordScore, note: "Weighted match against the job description's terms" },
                { label: "Required skills", score: skillsScore, note: skillsInJd.length ? `${skillsMatched.length} of ${skillsInJd.length} known skills` : "No known skills listed in the job" },
                { label: "Resume sections", score: sectionsScore, note: `${presentSections.length} of ${sectionResults.length} sections found` },
                { label: "Measurable impact", score: impactScore, note: `${metricCount} measurable figures found` },
            ],
            matched: matched.sort((a, b) => b.weight - a.weight).map((m) => m.term),
            missing: missing.sort((a, b) => b.weight - a.weight).slice(0, 12).map((m) => m.term),
            strengths,
            weaknesses,
            stats: { wordCount, metricCount },
        };
    }

    // ---------- Rendering ----------
    // Text is always set with textContent, never innerHTML, so resume text
    // cannot inject markup into the page.
    function chip(text, classes) {
        const span = document.createElement("span");
        span.className = `rounded-full px-3 py-1 text-xs font-medium ring-1 ${classes}`;
        span.textContent = text;
        return span;
    }

    function fillList(container, items, classes, emptyText) {
        container.replaceChildren();
        if (!items.length) {
            const p = document.createElement("p");
            p.className = "text-sm text-zinc-500";
            p.textContent = emptyText;
            container.appendChild(p);
            return;
        }
        items.forEach((item) => container.appendChild(chip(item, classes)));
    }

    function fillBulletList(list, items, emptyText) {
        list.replaceChildren();
        const itemsToShow = items.length ? items : [emptyText];
        itemsToShow.forEach((text) => {
            const li = document.createElement("li");
            li.textContent = text;
            list.appendChild(li);
        });
    }

    function barColor(score) {
        if (score >= 75) return "bg-gradient-to-r from-emerald-500 to-cyan-400";
        if (score >= 50) return "bg-gradient-to-r from-amber-500 to-orange-400";
        return "bg-gradient-to-r from-rose-500 to-fuchsia-500";
    }

    function renderBars(breakdown) {
        const container = $("bars");
        container.replaceChildren();
        breakdown.forEach((item) => {
            const wrapper = document.createElement("div");

            const header = document.createElement("div");
            header.className = "flex items-baseline justify-between text-sm text-zinc-200";
            const label = document.createElement("span");
            label.className = "font-semibold";
            label.textContent = item.label;
            const value = document.createElement("span");
            value.className = "text-zinc-400";
            value.textContent = `${Math.round(item.score)}%`;
            header.append(label, value);

            const track = document.createElement("div");
            track.className = "mt-2 h-2.5 w-full overflow-hidden rounded-full bg-white/10";
            const fill = document.createElement("div");
            fill.className = `bar-fill h-full rounded-full ${barColor(item.score)}`;
            fill.style.width = "0%";
            track.appendChild(fill);

            const note = document.createElement("p");
            note.className = "mt-1 text-xs text-zinc-500";
            note.textContent = item.note;

            wrapper.append(header, track, note);
            container.appendChild(wrapper);

            // Animate from 0 to the score on the next frame.
            requestAnimationFrame(() => {
                fill.style.width = `${Math.round(item.score)}%`;
            });
        });
    }

    function renderResults(report) {
        $("overall-score").textContent = report.overall;

        const ring = $("ring");
        const color = report.overall >= 75 ? "#10b981" : report.overall >= 50 ? "#f59e0b" : "#ef4444";
        ring.style.background = `conic-gradient(${color} ${report.overall * 3.6}deg, #e2e8f0 0deg)`;

        let label = "Needs work. Address the gaps below before you apply.";
        if (report.overall >= 75) label = "Strong match. A few tweaks will make it stronger.";
        else if (report.overall >= 50) label = "Good start. Close the missing keywords to improve your odds.";
        $("overall-label").textContent = label;

        renderBars(report.breakdown);

        $("stats").textContent = `${report.stats.wordCount} words · ${report.stats.metricCount} measurable figures`;

        fillList(
            $("matched"),
            report.matched,
            "bg-emerald-500/15 text-emerald-300 ring-emerald-400/30",
            "No job terms were found in your resume."
        );
        fillList(
            $("missing"),
            report.missing,
            "bg-rose-500/15 text-rose-300 ring-rose-400/30",
            "Nothing important is missing. Nice work."
        );
        fillBulletList(
            $("strengths"),
            report.strengths,
            "No clear strengths were found. Add more detail on your experience."
        );
        fillBulletList(
            $("weaknesses"),
            report.weaknesses,
            "No major weaknesses found."
        );

        results.classList.remove("hidden");
        results.scrollIntoView({ behavior: "smooth", block: "start" });
    }

    // ---------- Button ----------
    function setBusy(busy) {
        analyzeBtn.disabled = busy;
        analyzeBtn.textContent = busy ? "Reading your resume..." : "Analyze my resume";
    }

    analyzeBtn.addEventListener("click", async () => {
        clearError();

        if (!selectedFile) {
            showError("Please upload your resume first.");
            return;
        }
        const jd = jdInput.value.trim();
        if (jd.length < MIN_JD_CHARS) {
            showError("Please paste a job description. It needs at least a sentence or two.");
            return;
        }

        setBusy(true);
        try {
            const resumeText = await extractText(selectedFile);
            if (resumeText.trim().length < MIN_RESUME_CHARS) {
                throw new Error(
                    "We could not read enough text from that file. If it is a scanned PDF, export a text-based version."
                );
            }
            renderResults(analyze(resumeText, jd));
        } catch (error) {
            console.error(error);
            showError(error.message || "Something went wrong while reading your resume.");
        } finally {
            setBusy(false);
        }
    });
})();
