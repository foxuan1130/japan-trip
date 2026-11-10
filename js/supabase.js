
(() => {
    const SUPABASE_URL = 'https://ipplctkmnhkoqhaflezn.supabase.co';

    // 請填入 Publishable key，不是 Secret key
    const SUPABASE_KEY = 'sb_publishable_ewPIRiELzsOR3q00GMQvVw_3ambvkFs';

    window.supabaseClient = window.supabase.createClient(
        SUPABASE_URL,
        SUPABASE_KEY
    );

    console.log('Supabase Client 初始化成功');
})();

document.addEventListener('DOMContentLoaded', async () => {
    const client = window.supabaseClient;

    const loginButton = document.getElementById('loginButton');
    const loginModal = document.getElementById('loginModal');
    const loginForm = document.getElementById('loginForm');
    const closeLogin = document.getElementById('closeLogin');
    const loginStatus = document.getElementById('loginStatus');

    if (!loginButton || !loginModal || !loginForm ||
        !closeLogin || !loginStatus) {
        console.error('找不到登入介面的 HTML 元素');
        return;
    }

    async function updateLoginUI() {
        const { data: { session }, error } =
            await client.auth.getSession();

        if (error) {
            console.error('取得登入狀態失敗：', error.message);
            return;
        }

        loginButton.textContent = session ? '🔓 登出' : '🔐 登入';
    }

    loginButton.addEventListener('click', async () => {
        const { data: { session } } = await client.auth.getSession();

        if (session) {
            const { error } = await client.auth.signOut();

            if (error) {
                alert('登出失敗：' + error.message);
                return;
            }

            await updateLoginUI();
        } else {
            loginStatus.textContent = '';
            loginModal.classList.remove('hidden');
        }
    });

    closeLogin.addEventListener('click', () => {
        loginModal.classList.add('hidden');
    });

    loginForm.addEventListener('submit', async (event) => {
        event.preventDefault();

        const email = document.getElementById('loginEmail').value.trim();
        const password = document.getElementById('loginPassword').value;

        loginStatus.textContent = '登入中…';

        const { error } = await client.auth.signInWithPassword({
            email,
            password
        });

        if (error) {
            loginStatus.textContent = '登入失敗：' + error.message;
            return;
        }

        loginForm.reset();
        loginModal.classList.add('hidden');
        await updateLoginUI();
    });

    client.auth.onAuthStateChange(() => {
        updateLoginUI();
    });

    await updateLoginUI();
});
