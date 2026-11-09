'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export default function Home() {
  const router = useRouter();
  const [msg, setMsg] = useState('');
  return (
    <main>
      <h1>Add a note</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          const d = new FormData(e.currentTarget).get('due') as string;
          // A deliberately strict check, so there is something to complain about aloud.
          setMsg(/^\d{2}\/\d{2}\/\d{4}$/.test(d) ? 'Saved' : 'Error: invalid date');
        }}
      >
        <label>Title <input id="title" name="title" type="text" /></label>
        <br />
        <label>Due date <input id="due" name="due" type="text" /></label>
        <br />
        <label>Secret <input id="secret" name="secret" type="password" /></label>
        <br />
        <button id="btn-save" type="submit">Save note</button>
        <button id="btn-go" type="button" onClick={() => router.push('/notes')}>Go to notes</button>
      </form>
      <p id="msg">{msg}</p>
    </main>
  );
}
