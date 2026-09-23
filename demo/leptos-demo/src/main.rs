//! Leptos × Sightline Demo — 单文件实现。
//!
//! 故意嵌套有点深、有几个交互按钮，让 Sightline 的 selector 生成器
//! 有素材：浅 selector、深嵌套、兄弟节点歧义都能复现。

use leptos::prelude::*;

#[component]
fn App() -> impl IntoView {
    let (count, set_count) = signal(0i32);
    let (input_text, set_input_text) = signal(String::new());
    let (todos, set_todos) = signal(vec![
        Todo { id: 1, text: "Try Sightline".to_string(), done: false },
        Todo { id: 2, text: "Alt + click this item".to_string(), done: false },
        Todo { id: 3, text: "Select text and submit feedback".to_string(), done: true },
    ]);

    view! {
        <header data-testid="site-header" class="header">
            <h1>"Leptos x Sightline Demo"</h1>
            <p class="tagline">
                "Press " <kbd data-testid="kbd-alt">"Alt"</kbd> " + click any element to annotate it."
            </p>
        </header>

        <main class="main">
            <section data-testid="counter-card" class="card">
                <h2>"Counter"</h2>
                <p class="counter-value" data-testid="counter-value">
                    {move || count.get()}
                </p>
                <div class="button-row">
                    <button
                        data-testid="btn-decrement"
                        class="btn btn-secondary"
                        on:click=move |_| set_count.update(|c| *c = c.saturating_sub(1))
                    >
                        "- Decrement"
                    </button>
                    <button
                        data-testid="btn-increment"
                        class="btn btn-primary"
                        on:click=move |_| set_count.update(|c| *c = c.wrapping_add(1))
                    >
                        "+ Increment"
                    </button>
                </div>
            </section>

            <section data-testid="todo-card" class="card">
                <h2>"Todos"</h2>
                <form
                    data-testid="todo-form"
                    class="todo-form"
                    on:submit=move |ev| {
                        ev.prevent_default();
                        let text = input_text.get();
                        let trimmed = text.trim();
                        if !trimmed.is_empty() {
                            let mut new_todos = todos.get();
                            let next_id = new_todos.iter().map(|t| t.id).max().unwrap_or(0) + 1;
                            new_todos.push(Todo {
                                id: next_id,
                                text: trimmed.to_string(),
                                done: false,
                            });
                            set_todos.set(new_todos);
                            set_input_text.set(String::new());
                        }
                    }
                >
                    <input
                        data-testid="todo-input"
                        class="todo-input"
                        type="text"
                        placeholder="Add a todo..."
                        prop:value=input_text
                        on:input=move |ev| set_input_text.set(event_target_value(&ev))
                    />
                    <button data-testid="todo-add" class="btn btn-primary" type="submit">
                        "Add"
                    </button>
                </form>

                <ul data-testid="todo-list" class="todo-list">
                    {move || todos.get().into_iter().map(|todo| {
                        let todo_id = todo.id;
                        let todo_text = todo.text.clone();
                        let todo_done = todo.done;
                        view! {
                            <li data-testid={format!("todo-item-{todo_id}")} class="todo-item">
                                <input
                                    type="checkbox"
                                    class="todo-checkbox"
                                    prop:checked=todo_done
                                    on:change=move |_| {
                                        set_todos.update(|t| {
                                            if let Some(item) = t.iter_mut().find(|x| x.id == todo_id) {
                                                item.done = !item.done;
                                            }
                                        });
                                    }
                                />
                                <span class={if todo_done { "todo-text done" } else { "todo-text" }}>
                                    {todo_text}
                                </span>
                            </li>
                        }
                    }).collect::<Vec<_>>()}
                </ul>
            </section>

            <section data-testid="text-card" class="card">
                <h2>"Text selection playground"</h2>
                <p data-testid="selectable-text" class="selectable-text">
                    "Leptos is a modern Rust web framework. \
                     Select any portion of this paragraph with your mouse \
                     and Sightline will generate a CSS selector plus the \
                     exact text you highlighted. \
                     This lets AI agents know precisely which text the \
                     developer flagged as suspicious or wrong."
                </p>
            </section>
        </main>

        <footer class="footer">
            <p>
                "Built with "
                <a href="https://leptos.rs" target="_blank">"Leptos 0.8"</a>
                " + "
                <a href="https://github.com/hathaway/sightline">"Sightline"</a>
                ". Open devtools and load the SDK, then Alt+click anything."
            </p>
        </footer>
    }
}

#[derive(Clone, Debug)]
struct Todo {
    id: usize,
    text: String,
    done: bool,
}

fn main() {
    console_error_panic_hook::set_once();
    let _ = console_log::init_with_level(log::Level::Debug);
    web_sys::console::log_1(&"leptos demo main started".into());
    leptos::mount::mount_to_body(App);
}
