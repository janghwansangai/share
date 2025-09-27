// 필요한 모듈들을 가져옵니다.
const express = require('express');
const fetch = require('node-fetch'); // node.js 환경에서 fetch를 사용하기 위한 라이브러리

// Express 애플리케이션을 생성합니다.
const app = express();
// Render와 같은 클라우드 서비스는 PORT를 자동으로 지정해줍니다. process.env.PORT를 우선 사용합니다.
const PORT = process.env.PORT || 3000; 

// JSON 요청 본문을 파싱하기 위해 express.json() 미들웨어를 사용합니다.
app.use(express.json());
// 정적 파일(HTML, CSS, 클라이언트 JS)을 제공하기 위해 express.static 미들웨어를 사용합니다.
app.use(express.static('public')); 

// --- 중요: API 키는 코드에서 분리하여 '환경 변수'에서 가져옵니다 ---
const API_KEYS = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2
].filter(key => key); // 값이 있는 키만 배열에 포함시킵니다.
// --------------------------------------------------------------------

let currentKeyIndex = 0;
const requestQueue = [];
let isProcessing = false;

function getApiKey() {
    if (API_KEYS.length === 0) return null;
    const key = API_KEYS[currentKeyIndex % API_KEYS.length];
    currentKeyIndex++;
    return key;
}

async function callGeminiApi(prompt, generationConfig) {
    const apiKey = getApiKey();
    if (!apiKey) {
        throw new Error("서버에 설정된 Gemini API 키가 없습니다. 배포 플랫폼의 환경 변수를 확인해주세요.");
    }
    const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`;
    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: generationConfig,
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_MEDIUM_AND_ABOVE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_MEDIUM_AND_ABOVE" }
        ]
    };
    const response = await fetch(API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });
    if (!response.ok) {
        const errorData = await response.json();
        throw new Error(errorData.error?.message || `API 호출 오류! 상태: ${response.status}`);
    }
    const result = await response.json();
    if (result.candidates?.[0]?.finishReason === 'SAFETY') {
        throw new Error("API가 안전상의 이유로 응답 생성을 거부했습니다.");
    }
    if (!result.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error("API 응답 형식이 올바르지 않습니다.");
    }
    return result.candidates[0].content.parts[0].text;
}

async function processQueue() {
    if (isProcessing || requestQueue.length === 0) return;
    isProcessing = true;
    const { res, prompt, config, responseHandler } = requestQueue.shift();
    try {
        const result = await callGeminiApi(prompt, config);
        responseHandler(res, result);
    } catch (error) {
        console.error("큐 처리 중 오류:", error.message);
        res.status(500).json({ error: error.message });
    } finally {
        isProcessing = false;
        process.nextTick(processQueue);
    }
}

app.post('/api/situation', (req, res) => {
    const prompt = "초등학생이 학교 생활이나 친구 관계에서 겪을 수 있는, 공감이 필요한 구체적인 상황을 '반드시' 딱 한 문장으로만 만들어줘. 절대로 목록이나 여러 문장으로 만들지 마. 예시: '친한 친구가 다른 친구랑만 놀아서 속상했어.'";
    const config = { temperature: 1.0, topP: 0.95 };
    const responseHandler = (res, result) => {
        const situation = result.trim().split('\n')[0];
        res.json({ situation });
    };
    requestQueue.push({ res, prompt, config, responseHandler });
    processQueue();
});

app.post('/api/grade', (req, res) => {
    const { situation, expression } = req.body;
    if (!situation || !expression) {
        return res.status(400).json({ error: "상황과 표현을 모두 입력해야 합니다." });
    }
    const prompt = `당신은 초등학생의 공감 능력을 키워주는 친절하고 상냥한 AI 선생님입니다. 다음 '상황'에 대해 학생이 작성한 '공감 표현'을 100점 만점 기준으로 채점하고, 구체적인 피드백을 주세요. [평가 기준] 1. 상대방의 감정을 정확히 인지하고 언급했는가? 2. 판단이나 성급한 조언 대신, 감정을 있는 그대로 인정하고 위로하는가? 3. 자신의 경험에 빗대어 이야기하며 유대감을 형성하는가? 4. 상대방을 비난하거나, 감정을 무시하는가? 5. 전혀 관련 없는 이야기를 하는가? [피드백 형식] - 점수를 명확하게 제시해주세요. (예: 95점) - 칭찬과 개선점을 포함한 피드백을 '핵심만 간결하게' 2~3문장으로 요약해주세요. - 점수가 낮은 경우, 더 좋은 공감 표현 예시를 1개만 추천해주세요. - 모든 답변은 초등학생이 이해하기 쉬운 친근한 말투로 작성해주세요. --- [상황]: "${situation}" [학생의 공감 표현]: "${expression}" --- 이제 위 내용을 바탕으로 채점과 피드백을 시작해주세요.`;
    const config = { temperature: 0.7, topP: 0.95 };
    const responseHandler = (res, result) => {
        res.json({ feedback: result });
    };
    requestQueue.push({ res, prompt, config, responseHandler });
    processQueue();
});

app.listen(PORT, () => {
    console.log(`서버가 http://localhost:${PORT} 에서 실행 중입니다.`);
});

