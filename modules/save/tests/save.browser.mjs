import assert from 'node:assert/strict';

// 실제 IndexedDB·localStorage·BroadcastChannel에서 두 탭이 같은 레코드를 고치는 흐름을 한 페이지의 두 save로 재현한다.
export async function exerciseSave(page) {
    const R = await page.evaluate(async () => {
        const {
            createSave: CREATE_SAVE,
            indexedDbAdapter: INDEXED_DB,
            localStorageAdapter: LOCAL_STORAGE,
            memoryAdapter: MEMORY_ADAPTER,
            SaveError: SAVE_ERROR,
        } = await import('/dist/save.js');
        const OPTIONS = (adapter, extra = {}) => ({
                adapter,
                key: 'team',
                version: 1,
                create: () => ({ name: 'blue', credits: 10 }),
                validate(data) {
                    if (!Number.isSafeInteger(data.credits) || data.credits < 0) {
                        throw new Error('credits must be a non-negative integer');
                    }
                },
                ...extra,
            }),
            CATCH = async (promise) => {
                try {
                    await promise;
                    return null;
                } catch (error) {
                    return error instanceof SAVE_ERROR ? error.kind : error.message;
                }
            },
            RESULT = {};

        const MEMORY = CREATE_SAVE(OPTIONS(MEMORY_ADAPTER()));
        RESULT.created = { data: await MEMORY.load(), revision: MEMORY.revision };
        RESULT.skipped = { data: await MEMORY.update(() => false), revision: MEMORY.revision };
        RESULT.invalid = {
            error: await CATCH(
                MEMORY.update((draft) => {
                    draft.credits = -1;
                }),
            ),
            revision: MEMORY.revision,
        };
        await MEMORY.update((draft) => {
            draft.credits = 4;
        });
        RESULT.reloaded = { data: await MEMORY.load(), revision: MEMORY.revision };

        const DATABASE = `save-test-${Math.random().toString(36).slice(2)}`,
            A = CREATE_SAVE(OPTIONS(INDEXED_DB({ database: DATABASE }))),
            B = CREATE_SAVE(OPTIONS(INDEXED_DB({ database: DATABASE }))),
            NOTICES = [];
        B.onExternalChange((event) => NOTICES.push(event.revision));
        await A.load();
        await B.load();
        await A.update((draft) => {
            draft.credits = 7;
        });
        await new Promise((resolve) => setTimeout(resolve, 50));
        RESULT.conflict = {
            error: await CATCH(
                B.update((draft) => {
                    draft.credits = 1;
                }),
            ),
            notices: [...NOTICES],
            data: B.data,
        };
        await B.load();
        await B.update((draft) => {
            draft.credits += 1;
        });
        RESULT.afterReload = { b: B.data, a: await A.load(), revision: A.revision };
        A.dispose();
        B.dispose();
        RESULT.closed = await CATCH(A.load());

        const PREFIX = `save-test-${Math.random().toString(36).slice(2)}:`;
        localStorage.setItem(`${PREFIX}team`, '{broken');
        const BROKEN = CREATE_SAVE(OPTIONS(LOCAL_STORAGE({ prefix: PREFIX })));
        RESULT.unreadable = {
            load: await CATCH(BROKEN.load()),
            locked: BROKEN.locked,
            update: await CATCH(
                BROKEN.update((draft) => {
                    draft.credits = 1;
                }),
            ),
            preserved: localStorage.getItem(`${PREFIX}team`),
        };
        RESULT.reset = { data: await BROKEN.reset(), locked: BROKEN.locked, revision: BROKEN.revision };
        await BROKEN.update((draft) => {
            draft.credits = 2;
        });
        RESULT.reset.stored = JSON.parse(localStorage.getItem(`${PREFIX}team`));
        RESULT.resetReadable = { data: await MEMORY.reset(), revision: MEMORY.revision };
        localStorage.setItem(`${PREFIX}team`, JSON.stringify({ schema: 9, revision: 0, name: 'x', credits: 1 }));
        RESULT.future = await CATCH(CREATE_SAVE(OPTIONS(LOCAL_STORAGE({ prefix: PREFIX }))).load());
        localStorage.setItem(`${PREFIX}team`, JSON.stringify({ schema: 1, revision: 3, name: 'red', gold: 5 }));
        const MIGRATED = CREATE_SAVE(
            OPTIONS(LOCAL_STORAGE({ prefix: PREFIX }), {
                version: 2,
                migrate: { 1: ({ gold, ...rest }) => ({ ...rest, credits: gold }) },
            }),
        );
        RESULT.migrated = {
            data: await MIGRATED.load(),
            revision: MIGRATED.revision,
            stored: JSON.parse(localStorage.getItem(`${PREFIX}team`)),
        };
        localStorage.removeItem(`${PREFIX}team`);
        indexedDB.deleteDatabase(DATABASE);
        return RESULT;
    });
    assert.deepEqual(R.created, { data: { name: 'blue', credits: 10 }, revision: 0 });
    assert.deepEqual(R.skipped, { data: { name: 'blue', credits: 10 }, revision: 0 });
    assert.deepEqual(
        R.invalid,
        { error: 'credits must be a non-negative integer', revision: 0 },
        'a game rule error passes through unchanged and nothing is written',
    );
    assert.deepEqual(R.reloaded, { data: { name: 'blue', credits: 4 }, revision: 1 });
    assert.deepEqual(
        R.conflict,
        { error: 'conflict', notices: [1], data: { name: 'blue', credits: 10 } },
        'the stale tab is told and writes nothing',
    );
    assert.deepEqual(R.afterReload, { b: { name: 'blue', credits: 8 }, a: { name: 'blue', credits: 8 }, revision: 2 });
    assert.equal(R.closed, 'closed');
    assert.deepEqual(R.unreadable, { load: 'unreadable', locked: true, update: 'unreadable', preserved: '{broken' });
    assert.deepEqual(
        R.reset,
        {
            data: { name: 'blue', credits: 10 },
            locked: false,
            revision: 0,
            stored: { name: 'blue', credits: 2, schema: 1, revision: 1 },
        },
        'reset overwrites an unreadable record and unlocks the save',
    );
    assert.deepEqual(
        R.resetReadable,
        { data: { name: 'blue', credits: 10 }, revision: 2 },
        'reset continues the revision of a readable record',
    );
    assert.equal(R.future, 'unreadable');
    assert.deepEqual(R.migrated, {
        data: { name: 'red', credits: 5 },
        revision: 4,
        stored: { name: 'red', credits: 5, schema: 2, revision: 4 },
    });
    return R;
}
