
const KEY = 'japan_trip_v1_1';
const dates = ['12/28', '12/29', '12/30', '12/31', '01/01', '01/02', '01/03', '01/04', '01/05', '01/06', '01/07'];
const seed = {
    day: 0,
    items: [],
    expenses: [],
    tasks: []
};

const $ = id => document.getElementById(id);
const yen = n => '¥' + Number(n || 0).toLocaleString('ja-JP');
const esc = value => String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[ch]);
const makeId = () => typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;

let state;
try {
    const stored = JSON.parse(localStorage.getItem(KEY));
    state = stored && Array.isArray(stored.items) && Array.isArray(stored.expenses) && Array.isArray(stored.tasks)
        ? stored : structuredClone(seed);
} catch (error) {
    state = structuredClone(seed);
}
let day = Number.isInteger(state.day) && state.day >= 0 && state.day < dates.length ? state.day : 0;
let map = null;
let layer = null;
let taskFilter = 'CCX';

function save() {
    state.day = day;
    try {
        localStorage.setItem(KEY, JSON.stringify(state));
    } catch (error) {
        console.warn('無法儲存到 localStorage', error);
    }
}

async function loadCloudData() {
    const client = window.supabaseClient;

    if (!client) {
        console.warn('⚠️ Supabase 尚未初始化');
        return null;
    }

    const { data: sessionData, error: sessionError } =
        await client.auth.getSession();

    if (sessionError || !sessionData.session) {
        console.log('🔐 尚未登入，暫時使用本機資料');
        return null;
    }

    const { data, error } = await client
        .from('trip_data')
        .select('data, version')
        .eq('id', 'japan-trip')
        .maybeSingle();

    if (error) {
        console.error('❌ 雲端讀取失敗：', error.message);
        return null;
    }

    if (!data) {
        console.warn('⚠️ 雲端尚無旅行資料');
        return null;
    }

    console.log('☁️ 雲端旅行資料讀取成功');
    
return {
    trip: data.data,
    version: data.version
};

}

let cloudReady = false;

let cloudVersion = null;



let cloudSaveQueue = Promise.resolve();


let cloudSyncBlocked = false;

const PENDING_SYNC_KEY = 'japan_trip_v1_1_pending';

function backupPendingSync(snapshot, expectedVersion) {
    try {
        
        const backup = {
            backupId: crypto.randomUUID(),
            savedAt: new Date().toISOString(),
            expectedVersion: expectedVersion,
            data: structuredClone(snapshot)
        };


        localStorage.setItem(
            PENDING_SYNC_KEY,
            JSON.stringify(backup)
        );

        console.log('💾 待同步資料已備份到本機');
        return true;
    } catch (error) {
        console.error('❌ 無法備份待同步資料：', error);
        return false;
    }
}

function clearPendingSyncIfMatched(snapshot) {
    try {
        const raw = localStorage.getItem(PENDING_SYNC_KEY);

        if (!raw) return;

        const backup = JSON.parse(raw);

        // 只有備份內容與剛同步成功的資料一致，才允許清除
        if (JSON.stringify(backup.data) === JSON.stringify(snapshot)) {
            localStorage.removeItem(PENDING_SYNC_KEY);
            console.log('✅ 已清除成功同步的本機備份');
        } else {
            console.log('📦 保留較新的待同步備份');
        }
    } catch (error) {
        console.error('❌ 檢查待同步備份失敗：', error);
    }
}

function checkPendingSyncOnStartup() {
    try {
        const raw = localStorage.getItem(PENDING_SYNC_KEY);

        if (!raw) {
            console.log('✅ 沒有待同步備份');
            return false;
        }

        const backup = JSON.parse(raw);

        if (
            !backup ||
            !backup.backupId ||
            !backup.data ||
            !Array.isArray(backup.data.items) ||
            !Array.isArray(backup.data.tasks) ||
            !Array.isArray(backup.data.expenses)
        ) {
            console.warn('⚠️ 待同步備份格式異常，請勿清除');
            return true;
        }

        console.warn(
            '📦 發現尚未確認同步的本機備份',
            {
                backupId: backup.backupId,
                savedAt: backup.savedAt,
                expectedVersion: backup.expectedVersion
            }
        );

        return true;
    } catch (error) {
        console.error('❌ 無法檢查待同步備份：', error);
        return true;
    }
}


function queueCloudSave() {
    if (!cloudReady || cloudSyncBlocked) {
        console.warn('⚠️ 雲端尚未準備完成，或同步已暫停');
        return Promise.reject(new Error('雲端同步目前不可用'));
    }


const snapshot = structuredClone(state);

// 每個人自行保留目前瀏覽日期
delete snapshot.day;

// 雲端寫入前，先備份待同步資料
if (!backupPendingSync(snapshot, cloudVersion)) {
    cloudSyncBlocked = true;
    cloudReady = false;
    setEditingLocked(true);

    return Promise.reject(
        new Error('本機備份失敗，已停止雲端同步')
    );
}

cloudSaveQueue = cloudSaveQueue

        .catch(() => {
            // 清除上一筆佇列的失敗狀態
            // 不會解除 cloudSyncBlocked 的保護
        })

        .then(async () => {
        // 如果之前同步失敗，禁止繼續寫入
        if (cloudSyncBlocked) {
            throw new Error('雲端同步已暫停');
        }

        const client = window.supabaseClient;


        const { data: sessionData, error: sessionError } =
            await client.auth.getSession();

        if (sessionError || !sessionData.session) {
            throw new Error('尚未登入 Supabase');
        }

        const { data, error } = await client.rpc(
            'update_trip_safely',
            {
                p_trip_id: 'japan-trip',
                p_expected_version: cloudVersion,
                p_new_data: snapshot
            }
        );

        if (error) throw error;

        const result = data?.[0];

        if (!result?.update_success) {
            throw new Error('版本衝突：雲端資料已被其他裝置修改');
        }


        cloudVersion = Number(result.new_version);

        // 只有確認雲端更新成功後，才清除對應的待同步備份
        clearPendingSyncIfMatched(snapshot);

        console.log('☁️ 安全同步成功，版本：', cloudVersion);

    }).catch(error => {
        cloudSyncBlocked = true;
        cloudReady = false;
        setEditingLocked(true);

        console.error('❌ 雲端同步已暫停：', error.message);

        throw error;
    });

    return cloudSaveQueue;
}



async function saveCloudData() {
    if (!cloudReady) {
        console.warn('⚠️ 雲端尚未準備完成，取消寫入');
        return;
    }

    const client = window.supabaseClient;

    if (!client) {
        console.error('❌ Supabase 尚未初始化');
        return;
    }

    const { data: sessionData, error: sessionError } =
        await client.auth.getSession();

    if (sessionError || !sessionData.session) {
        console.warn('🔐 尚未登入，取消雲端寫入');
        return;
    }

    const { error } = await client
        .from('trip_data')
        .update({
            data: structuredClone(state)
        })
        .eq('id', 'japan-trip');

    if (error) {
        console.error('❌ 雲端儲存失敗：', error.message);
        return;
    }

    console.log('☁️ Japan Trip 雲端儲存成功');
}


function dayItems() {
    return state.items
        .filter(item => item.date === dates[day])
        .sort((a, b) => {
            // 沒有時間的行程排在最後
            if (!a.time && !b.time) return 0;
            if (!a.time) return 1;
            if (!b.time) return -1;

            // HH:MM 格式可以直接比較
            return a.time.localeCompare(b.time);
        });
}

function dayExpenses(date = dates[day]) {
    return state.expenses.filter(item => item.date === date);
}

function initMap() {
    if (!window.L) {
        $('map').textContent = '地圖載入失敗，請檢查網路連線。';
        return;
    }
    map = L.map('map', { scrollWheelZoom: false }).setView([34.68, 135.51], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);
    layer = L.layerGroup().addTo(map);
}
const markersById = new Map();
function renderMap() {
    if (!map || !layer) return;
    layer.clearLayers();
    markersById.clear();
    const points = dayItems().filter(item =>
        item.lat !== '' && item.lat != null && item.lng !== '' && item.lng != null &&
        Number.isFinite(Number(item.lat)) && Number.isFinite(Number(item.lng)) &&
        Math.abs(Number(item.lat)) <= 90 && Math.abs(Number(item.lng)) <= 180
    );
    points.forEach((item, index) => {
        const icon = L.divIcon({
            html: `<div class="pin">${index + 1}</div>`,
            iconSize: [29, 29],
            iconAnchor: [14, 14],
            className: ''
        });
        const marker = L.marker([Number(item.lat), Number(item.lng)], { icon }).addTo(layer);
        const popup = document.createElement('div');
        const label = document.createElement('span');
        label.textContent = `${item.name} · `;
        const link = document.createElement('a');
        link.href = 'https://www.google.com/maps/search/?api=1&query=' +
            encodeURIComponent(`${item.lat},${item.lng}`);
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = '開啟 Google Maps ↗';
        popup.append(label, link);
        marker.bindPopup(popup);
        markersById.set(String(item.id), marker);
    });
    if (points.length > 1) {
        L.polyline(points.map(item => [Number(item.lat), Number(item.lng)]), {
            color: '#c87976', weight: 3, dashArray: '7 8'
        }).addTo(layer);
    }
    if (points.length) {
        map.fitBounds(L.latLngBounds(points.map(item => [Number(item.lat), Number(item.lng)])).pad(0.25), { maxZoom: 14 });
    } else {
        map.setView([34.68, 135.51], 11);
    }
}

function renderSummary() {
    const expenses = dayExpenses();
    const ccxOwes = expenses.filter(x => x.payer === 'Josh').reduce((sum, x) => sum + Number(x.ccx), 0);
    const joshOwes = expenses.filter(x => x.payer === 'CCX').reduce((sum, x) => sum + Number(x.josh), 0);
    $('ccxOwes').textContent = yen(ccxOwes);
    $('joshOwes').textContent = yen(joshOwes);
    $('summaryDate').textContent = `${dates[day]} · 日本旅程`;
    $('detailTable').innerHTML = expenses.length
        ? `<div style="overflow:auto"><table><thead><tr><th>項目</th><th>金額</th><th>付款人</th><th>CCX 負擔</th><th>Josh 負擔</th></tr></thead><tbody>${expenses.map(x => `
            <tr><td>${esc(x.name)}</td><td>${yen(x.total)}</td><td>${esc(x.payer)}</td><td>${yen(x.ccx)}</td><td>${yen(x.josh)}</td></tr>
        `).join('')}</tbody></table></div>`
        : '<p class="empty">這天還沒有消費紀錄</p>';
    $('netSettle').textContent = ccxOwes === joshOwes
        ? '互抵後：兩人已結清'
        : ccxOwes > joshOwes
            ? `互抵後：CCX 應付 Josh ${yen(ccxOwes - joshOwes)}`
            : `互抵後：Josh 應付 CCX ${yen(joshOwes - ccxOwes)}`;
}

function renderItems() {
    const items = dayItems();
    $('itinerary').innerHTML = items.length ? items.map(item => `
        <div class="item" draggable="true" data-id="${esc(item.id)}">
            <div class="grip" title="拖曳排序">⠿</div>
            <div class="itemmain">
                <div class="itemtop"><strong>${esc(item.time)}　${esc(item.name)}</strong></div>
                <div class="desc">${esc(item.desc)}</div>
                ${item.place ? `<div class="sub">📍 ${esc(item.place)}</div>` : ''}
            </div>
            <div class="actions">
                <button type="button" data-edit="${esc(item.id)}" title="編輯"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-pencil preview-icon"><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/></svg></button>
                <button type="button" data-del="${esc(item.id)}" title="刪除"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-x preview-icon"><path d="M18 6 6 18"/><path d="m6 6 12 12"/></svg></button>
            </div>
        </div>
    `).join('') : '<div class="panel empty">這天還沒有行程，按下方按鈕新增吧！</div>';

    let dragId = null;
    document.querySelectorAll('.item').forEach(element => {
        element.addEventListener('dragstart', event => {
            dragId = element.dataset.id;
            element.classList.add('dragging');
            event.dataTransfer.effectAllowed = 'move';
            event.dataTransfer.setData('text/plain', dragId);
        });
        element.addEventListener('dragend', () => element.classList.remove('dragging'));
        element.addEventListener('dragover', event => event.preventDefault());
        element.addEventListener('drop', event => {
            event.preventDefault();
            reorder(dragId || event.dataTransfer.getData('text/plain'), element.dataset.id);
        });
    });
    document.querySelectorAll('[data-edit]').forEach(button => {
        button.onclick = () => openItem(button.dataset.edit);
    });
    document.querySelectorAll('[data-del]').forEach(button => {
        button.onclick = () => {
            if (!confirm('確定刪除這個行程？')) return;
            state.items = state.items.filter(item => item.id !== button.dataset.del);
            save();
            render();
            
            queueCloudSave()?.catch(error => {
            console.error('❌ 刪除行程同步失敗：', error);
            alert('刪除行程的雲端同步失敗！請保留本機資料，暫時不要重新整理。');
});

        };
    });
        // 點擊行程卡片，地圖自動定位到該景點
    document.querySelectorAll('.item').forEach(element => {
        element.addEventListener('click', event => {
            // 點擊編輯、刪除按鈕時不觸發定位
            if (event.target.closest('button')) return;

            const item = state.items.find(item => item.id === element.dataset.id);
            if (!item) return;

            const lat = Number(item.lat);
            const lng = Number(item.lng);


            // 沒有有效座標就不定位
            if (item.lat === '' || item.lng === '' ||
                !Number.isFinite(lat) || !Number.isFinite(lng) ||
                Math.abs(lat) > 90 || Math.abs(lng) > 180) return;

            // 滾動到地圖
            $('map').scrollIntoView({
                behavior: 'smooth',
                block: 'center'
            });

            // 地圖移動並放大
            if (map) {
                map.invalidateSize();
                map.flyTo([lat, lng], 16, {
                    duration: 1.2
                });
                const marker = markersById.get(String(item.id));
                if (marker) {
                    map.once('moveend', () => {
                        marker.openPopup();
                    });
                }
            }
        });
    });
    enableTouchSort();
}


function reorder(from, to) {
    if (!cloudReady || cloudSyncBlocked) {
        console.warn('🔒 雲端尚未準備完成，禁止調整行程順序');
        return;
    }
    if (!from || !to || from === to) return;

    const items = dayItems();
    const fromIndex = items.findIndex(item => item.id === from);
    const toIndex = items.findIndex(item => item.id === to);

    if (fromIndex < 0 || toIndex < 0) return;

    const [moved] = items.splice(fromIndex, 1);
    items.splice(toIndex, 0, moved);

    state.items = [
        ...state.items.filter(item => item.date !== dates[day]),
        ...items
    ];

    save();
    render();

    // 拖曳排序完成後，自動同步至 Supabase
    queueCloudSave()?.catch(error => {
        console.error('❌ 行程排序同步失敗：', error);
        alert('行程排序尚未成功同步至雲端，請先不要重新整理網頁。');
    });
}


function enableTouchSort() {
    document.querySelectorAll('.grip').forEach(grip => {
        let source = null;
        grip.addEventListener('pointerdown', event => {
            if (event.pointerType === 'mouse') return;
            source = grip.closest('.item')?.dataset.id;
            grip.setPointerCapture(event.pointerId);
        });
        grip.addEventListener('pointerup', event => {
            if (!source) return;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest('.item');
            const destination = target?.dataset.id;
            const previous = source;
            source = null;
            if (destination) reorder(previous, destination);
        });
        grip.addEventListener('pointercancel', () => { source = null; });
    });
}


function renderExpenses() {
    const expenses = [...state.expenses].sort(
        (a, b) => dates.indexOf(a.date) - dates.indexOf(b.date)
    );

    $('allExpenses').innerHTML = expenses.length
        ? `<div style="overflow:auto">
            <table>
                <thead>
                    <tr>
                        <th>日期</th>
                        <th>項目</th>
                        <th>總金額</th>
                        <th>付款人</th>
                        <th>CCX 負擔</th>
                        <th>Josh 負擔</th>
                        <th>操作</th>
                    </tr>
                </thead>
                <tbody>
                    ${expenses.map(x => `
                        <tr>
                            <td>${esc(x.date)}</td>
                            <td>${esc(x.name)}</td>
                            <td>${yen(x.total)}</td>
                            <td>${esc(x.payer)}</td>
                            <td>${yen(x.ccx)}</td>
                            <td>${yen(x.josh)}</td>
                            <td>
                                <button type="button" class="smallbtn"
                                    data-exedit="${esc(x.id)}">
                                    編輯
                                </button>
                                <button type="button" class="smallbtn"
                                    data-exdel="${esc(x.id)}">
                                    刪除
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>`
        : '<p class="empty">還沒有消費紀錄</p>';

    // 編輯消費
    document.querySelectorAll('[data-exedit]').forEach(button => {
        button.onclick = () => {
            editExpense(button.dataset.exedit);
        };
    });

    // 刪除消費
    document.querySelectorAll('[data-exdel]').forEach(button => {
        button.onclick = () => {
            if (!confirm('刪除這筆消費？')) return;

            state.expenses = state.expenses.filter(
                x => String(x.id) !== button.dataset.exdel
            );
            save();
            render();

            queueCloudSave().catch(error => {
                console.error('❌ 刪除旅費同步失敗：', error);
                alert('刪除旅費尚未成功同步，請先不要重新整理網頁。');
            });

        };
    });
}

function editExpense(id) {
    const expense = state.expenses.find(
        x => String(x.id) === String(id)
    );

    if (!expense) {
        alert('找不到這筆消費紀錄');
        return;
    }

    // 記住正在編輯的紀錄
    $('expenseEditId').value = expense.id;

    // 修改視窗標題
    $('expenseModalTitle').textContent = '編輯消費';

    // 將原本資料帶入表單
    $('expenseDate').value = expense.date;
    $('expenseName').value = expense.name;
    $('expenseTotal').value = expense.total;
    $('expensePayer').value = expense.payer;
    $('expenseCcx').value = expense.ccx;
    $('expenseJosh').value = expense.josh;

    // 開啟視窗
    $('expenseModal').classList.remove('hidden');
}

function migrateTasks() {
    // 只轉換舊格式，不重複轉換已經分配好的任務
    const migrated = [];

    state.tasks.forEach(task => {
        if (task.owner === 'CCX' || task.owner === 'Josh') {
            migrated.push(task);
        } else {
            // 沒有 owner 或標記為「共同」的舊任務
            // 複製成兩份，各自有獨立 ID 和完成狀態
            migrated.push({
                ...task,
                id: makeId(),
                owner: 'CCX'
            });

            migrated.push({
                ...task,
                id: makeId(),
                owner: 'Josh'
            });
        }
    });

    state.tasks = migrated;
}


function renderTasks() {
    const visibleTasks = state.tasks.filter(
        task => task.owner === taskFilter
    );

    const completed = visibleTasks.filter(task => task.done).length;

    $('taskProgress').textContent =
        `${taskFilter} 已完成 ${completed} / ${visibleTasks.length} 項`;

    $('checklist').innerHTML = visibleTasks.length
        ? visibleTasks.map(task => `
            <div class="checkline">
                <input
                    type="checkbox"
                    data-task="${esc(task.id)}"
                    ${task.done ? 'checked' : ''}
                >

                <span style="flex:1;${task.done ? 'text-decoration:line-through;color:#aaa' : ''}">
                    ${esc(task.text)}
                </span>

                <button
                    type="button"
                    class="smallbtn"
                    data-taskdel="${esc(task.id)}"
                >
                    <svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-trash preview-icon"><path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
                </button>
            </div>
        `).join('')
        : '<p class="empty">目前沒有待辦事項</p>';

    document.querySelectorAll('[data-task]').forEach(input => {
        input.onchange = () => {
            if (!cloudReady || cloudSyncBlocked) {
                input.checked = !input.checked;
                alert('雲端同步尚未就緒，目前無法修改待辦。');
                return;
            }
            const task = state.tasks.find(
                x => x.id === input.dataset.task
            );

            
            if (task) {
                task.done = input.checked;
                save();
                render();

                // 勾選狀態變更後同步 Supabase
                queueCloudSave().catch(error => {
                    console.error('❌ 待辦同步失敗：', error);
                    alert('待辦尚未成功同步，請先不要重新整理網頁。');
                });
            }

        };
    });

document.querySelectorAll('[data-taskdel]').forEach(button => {
    button.onclick = () => {
        if (!cloudReady || cloudSyncBlocked) {
            alert('雲端同步尚未就緒，目前無法刪除待辦。');
            return;
        }
        state.tasks = state.tasks.filter(
            x => x.id !== button.dataset.taskdel
        );

        save();
        render();

        // 刪除待辦後同步 Supabase
        queueCloudSave().catch(error => {
            console.error('❌ 刪除待辦同步失敗：', error);
            alert('刪除待辦尚未成功同步，請先不要重新整理網頁。');
        });
    };
});  

    document.querySelectorAll('.task-filter').forEach(button => {
        button.classList.toggle(
            'active',
            button.dataset.owner === taskFilter
        );
    });
}

document.querySelectorAll('.task-filter').forEach(button => {
    button.onclick = () => {
        taskFilter = button.dataset.owner;
        renderTasks();
    };
});



function render() {
    state.day = day;

    $('dayTitle').textContent =
        `${dates[day]} ｜ ${day === 0 ? '大阪・市區' : '每日行程'}`;

    $('prevDay').disabled = day === 0;
    $('nextDay').disabled = day === dates.length - 1;

    renderSummary();
    renderItems();
    renderMap();
    renderExpenses();
    renderTasks();

    // 每次重建畫面後，重新套用編輯鎖定
    setEditingLocked(!cloudReady || cloudSyncBlocked);
}


function openItem(id) {
    const item = state.items.find(x => x.id === id);
    $('modalTitle').textContent = item ? '編輯行程' : '新增行程';
    $('editId').value = item?.id || '';
    $('editDate').value = item?.date || dates[day];
    $('editTime').value = item?.time || '10:00';
    $('editName').value = item?.name || '';
    $('editPlace').value = item?.place || '';
    $('editLat').value = item?.lat ?? '';
    $('editLng').value = item?.lng ?? '';
    $('editDesc').value = item?.desc || '';
    $('lookupStatus').textContent = '';
    $('placeResults').innerHTML = '';
    $('placeResults').classList.add('hidden');
    $('modal').classList.remove('hidden');
}


$('prevDay').onclick = () => {
    if (day > 0) {
        day--;
        save();
        render();
    }
};

$('nextDay').onclick = () => {
    if (day < dates.length - 1) {
        day++;
        save();
        render();
    }
};

$('toggleDetail').onclick = () => {
    const isOpen = !$('detail').classList.toggle('hidden');
    $('toggleDetail').textContent = isOpen ? '收合⬆️' : '明細⬇️';
    $('toggleDetail').setAttribute('aria-expanded', String(isOpen));
};

document.querySelectorAll('nav button[data-tab]').forEach(button => {
    button.onclick = () => {
        document.querySelectorAll('nav button[data-tab]').forEach(x => x.classList.toggle('active', x === button));
        document.querySelectorAll('.tabpage').forEach(x => x.classList.toggle('active', x.id === button.dataset.tab));
        if (button.dataset.tab === 'schedule' && map) setTimeout(() => map.invalidateSize(), 100);
    };
});

$('addItem').onclick = () => openItem();
$('cancelEdit').onclick = () => $('modal').classList.add('hidden');
$('editForm').onsubmit = event => {
    event.preventDefault();

    if (!cloudReady || cloudSyncBlocked) {
        alert('雲端尚未準備完成或同步已暫停，目前無法修改行程。');
        return;
    }

    const id = $('editId').value;
    const latText = $('editLat').value.trim();
    const lngText = $('editLng').value.trim();
    if ((latText === '') !== (lngText === '')) {
        alert('請同時填寫緯度與經度，或兩欄都留空。');
        return;
    }
    const item = {
        id: id || makeId(),
        date: $('editDate').value,
        time: $('editTime').value,
        name: $('editName').value.trim(),
        place: $('editPlace').value.trim(),
        lat: latText,
        lng: lngText,
        desc: $('editDesc').value.trim()
    };
    if (!item.name) return;
    if (id) state.items = state.items.map(x => x.id === id ? item : x);
    else state.items.push(item);
    $('modal').classList.add('hidden');
    
    day = Math.max(0, dates.indexOf(item.date));
    save();
    render();

    // 行程變更後，自動排隊儲存到 Supabase
    queueCloudSave()?.catch(error => {
        console.error('❌ 行程雲端同步失敗：', error);
        alert('雲端同步失敗！資料已保留在本機，請先不要重新整理網頁。');
    });

};


$('lookupPlace').onclick = async () => {
    const query = $('editPlace').value.trim();
    const status = $('lookupStatus');
    const resultsBox = $('placeResults');
    const searchButton = $('lookupPlace');

    resultsBox.innerHTML = '';
    resultsBox.classList.add('hidden');

    if (!query) {
        status.textContent = '請先輸入地點名稱';
        return;
    }

    status.textContent = '正在搜尋地點…';
    searchButton.disabled = true;

    try {
        const url = new URL(
            'https://nominatim.openstreetmap.org/search'
        );

        url.searchParams.set('format', 'jsonv2');
        url.searchParams.set('q', query);
        url.searchParams.set('limit', '5');
        
        url.searchParams.set('addressdetails', '1');

        const response = await fetch(url.toString(), {
            headers: {
                'Accept-Language': 'zh-TW'
            }
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const places = await response.json();

        if (places.length === 0) {
            status.textContent = '找不到地點，請換個名稱搜尋';
            return;
        }

        status.textContent =
            `找到 ${places.length} 個地點，請選擇：`;

        places.forEach(place => {
            const option = document.createElement('button');

            option.type = 'button';
            option.className = 'place-option';

            option.textContent = place.display_name;

            option.onclick = () => {
                $('editPlace').value =
                    place.name || place.display_name.split(',')[0];

                $('editLat').value = place.lat;
                $('editLng').value = place.lon;

                status.textContent =
                    '✅ 已選擇：' + place.display_name;

                resultsBox.innerHTML = '';
                resultsBox.classList.add('hidden');
            };

            resultsBox.appendChild(option);
        });

        resultsBox.classList.remove('hidden');

    } catch (error) {
        status.textContent = '搜尋失敗：' + error.message;
        console.error('地點搜尋失敗：', error);

    } finally {
        searchButton.disabled = false;
    }
};



$('addExpense').onclick = () => {
    // 清空表單
    $('expenseForm').reset();

    // 清除正在編輯的紀錄 ID
    $('expenseEditId').value = '';

    // 設定視窗標題
    $('expenseModalTitle').textContent = '新增消費';

    // 預設選擇目前日期
    $('expenseDate').value = dates[day];

    // 開啟消費視窗
    $('expenseModal').classList.remove('hidden');
};

$('cancelExpense').onclick = () => $('expenseModal').classList.add('hidden');

$('expenseForm').onsubmit = event => {
    event.preventDefault();

    if (!cloudReady || cloudSyncBlocked) {
        alert('雲端尚未準備完成或同步已暫停，目前無法修改旅費。');
        return;
    }

    const total = Number($('expenseTotal').value);
    const ccx = Number($('expenseCcx').value);
    const josh = Number($('expenseJosh').value);

    // 檢查金額
    if (
        ![total, ccx, josh].every(Number.isFinite) ||
        [total, ccx, josh].some(x => x < 0) ||
        total !== ccx + josh
    ) {
        alert('金額不能為負數，且 CCX 與 Josh 負擔加總必須等於總金額');
        return;
    }

    // 取得表單資料
    const expenseData = {
        date: $('expenseDate').value,
        name: $('expenseName').value.trim(),
        total: total,
        payer: $('expensePayer').value,
        ccx: ccx,
        josh: josh
    };

    // 檢查是否正在編輯
    const editId = $('expenseEditId').value;

    if (editId) {
        // 編輯模式：更新原本的紀錄
        const expense = state.expenses.find(
            e => String(e.id) === editId
        );

        if (!expense) {
            alert('找不到要編輯的消費紀錄');
            return;
        }

        Object.assign(expense, expenseData);

    } else {
        // 新增模式：建立新紀錄
        state.expenses.push({
            id: makeId(),
            ...expenseData
        });
    }

    // 關閉視窗並重新計算
    $('expenseModal').classList.add('hidden');
    $('expenseEditId').value = '';
    save();
    render();

    queueCloudSave().catch(error => {
        console.error('❌ 旅費同步失敗：', error);
        alert('旅費尚未成功同步至雲端，請先不要重新整理網頁。');
    });

};


$('addTask').onclick = () => {
    if (!cloudReady || cloudSyncBlocked) {
        alert('雲端尚未準備完成或同步已暫停，目前無法新增待辦。');
        return;
    }
    const text = $('newTask').value.trim();

    if (!text) return;

    state.tasks.push({
        id: makeId(),
        text: text,
        owner: taskFilter,
        done: false
    });

    $('newTask').value = '';
    save();
    render();
    // 新增待辦後同步 Supabase
    queueCloudSave().catch(error => {
        console.error('❌ 新增待辦同步失敗：', error);
        alert('新增待辦尚未成功同步，請先不要重新整理網頁。');
    });
};

for (const id of ['editDate', 'expenseDate']) {
    $(id).innerHTML = dates.map(date => `<option value="${date}">${date}</option>`).join('');
}

function setEditingLocked(locked) {
    const selectors = [
        '#addItem',
        '#addTask',
        '#addExpense',
        '[data-edit]',
        '[data-del]',
        '[data-task]',
        '[data-taskdel]',
        '[data-exedit]',
        '[data-exdel]',
        '.grip'
    ];

    document.querySelectorAll(selectors.join(',')).forEach(element => {
        if (element.matches('.grip')) {
            element.style.pointerEvents = locked ? 'none' : '';
        } else {
            element.disabled = locked;
        }
    });
}

async function startApp() {

const hasPendingBackup = checkPendingSyncOnStartup();

    if (hasPendingBackup) {
        cloudSyncBlocked = true;
        cloudReady = false;

        alert(
            '偵測到尚未確認同步的旅行資料備份。\n' +
            '為避免覆蓋資料，已暫停編輯。\n' +
            '請先不要清除瀏覽器資料。'
        );
    }

    // 先顯示本機資料
    migrateTasks();
    initMap();


    // 雲端載入期間禁止編輯
    setEditingLocked(true);

    // 嘗試讀取雲端資料
    const cloud = await loadCloudData();

 
if (!cloud) {
    cloudReady = false;

    console.warn('⚠️ 雲端資料尚未載入，暫停編輯以保護資料');

    alert(
        '目前無法載入雲端旅行資料。\n' +
        '為避免資料不同步，已暫時停用編輯功能。\n' +
        '請確認已登入且網路正常，再重新整理網頁。'
    );

    return;
}


    // 確認雲端資料格式正確
    
    if (!Array.isArray(cloud.trip?.items) ||
        !Array.isArray(cloud.trip?.tasks) ||
        !Array.isArray(cloud.trip?.expenses) ||
        !Number.isSafeInteger(cloud.version) ||
        cloud.version < 1) {

        
        console.error('❌ 雲端資料格式不正確，保留本機資料');
        cloudReady = false;
        alert('雲端資料格式異常，已暫停編輯，請先檢查資料。');
        return;

    }

    
    state = cloud.trip;
    state.day = day;
    $('tripContent').classList.remove('hidden');

    // 記住目前雲端版本
    cloudVersion = cloud.version;

    render();


    if (hasPendingBackup) {
        cloudReady = false;
        cloudSyncBlocked = true;
        setEditingLocked(true);
        console.warn('🔒 存在待同步備份，維持編輯鎖定');
    } else {
        cloudReady = true;
        cloudSyncBlocked = false;
        setEditingLocked(false);
    }

    console.log('✅ Japan Trip 已載入雲端資料');
}

startApp();